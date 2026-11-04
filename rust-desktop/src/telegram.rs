use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::Database;
use crate::models::PartRecord;
use crate::bot_api::BotApiProcess;
use crate::sync_ext::RwLockExt;

#[derive(Clone)]
pub struct TelegramEngine {
    pub client: Client,
    pub db: Arc<Database>,
    pub bot_api_url: String,
    pub bot_api: Arc<BotApiProcess>,
    #[allow(dead_code)]
    pub channel_id: String,
}

fn strip_zip_header_if_present(raw: Vec<u8>) -> Vec<u8> {
    if raw.starts_with(b"PK\x03\x04") && raw.len() >= 30 {
        let name_len = u16::from_le_bytes([raw[26], raw[27]]) as usize;
        let extra_len = u16::from_le_bytes([raw[28], raw[29]]) as usize;
        let header_len = 30 + name_len + extra_len;
        if raw.len() > header_len {
            return raw[header_len..].to_vec();
        }
    }
    raw
}

fn unpack_part_to_file_with_chunk<F: FnMut(u64)>(
    src_path: &Path,
    dest_path: &Path,
    mut on_chunk: F,
) -> Result<u64, String> {
    use std::io::{Read, Write, Seek};
    let mut file = std::fs::File::open(src_path)
        .map_err(|e| format!("cannot open part file {}: {}", src_path.display(), e))?;

    if let Ok(mut archive) = zip::ZipArchive::new(&mut file) {
        if archive.len() > 0 {
            if let Ok(mut entry) = archive.by_index(0) {
                let mut out = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dest_path)
                    .map_err(|e| format!("cannot open dest for append: {}", e))?;
                let mut buf = [0u8; 262144];
                let mut total = 0u64;
                loop {
                    let n = entry.read(&mut buf)
                        .map_err(|e| format!("cannot unpack zip part: {}", e))?;
                    if n == 0 { break; }
                    out.write_all(&buf[..n])
                        .map_err(|e| format!("cannot write unpacked part: {}", e))?;
                    total += n as u64;
                    on_chunk(n as u64);
                }
                return Ok(total);
            }
        }
    }

    file.seek(std::io::SeekFrom::Start(0))
        .map_err(|e| format!("seek failed on part: {}", e))?;
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dest_path)
        .map_err(|e| format!("cannot open dest for raw append: {}", e))?;
    let mut buf = [0u8; 262144];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)
            .map_err(|e| format!("cannot read raw part: {}", e))?;
        if n == 0 { break; }
        out.write_all(&buf[..n])
            .map_err(|e| format!("cannot copy raw part: {}", e))?;
        total += n as u64;
        on_chunk(n as u64);
    }
    Ok(total)
}

fn get_bot_api_active_bytes(bot_api_dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![bot_api_dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&current) {
            for entry in entries.flatten() {
                if let Ok(ft) = entry.file_type() {
                    if ft.is_dir() {
                        stack.push(entry.path());
                    } else if ft.is_file() {
                        let path = entry.path();
                        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                            if ext.eq_ignore_ascii_case("log")
                                || ext.eq_ignore_ascii_case("db")
                                || ext.eq_ignore_ascii_case("lock")
                                || ext.eq_ignore_ascii_case("wal")
                                || ext.eq_ignore_ascii_case("shm")
                            {
                                continue;
                            }
                        }
                        if let Ok(meta) = entry.metadata() {
                            total = total.saturating_add(meta.len());
                        }
                    }
                }
            }
        }
    }
    total
}

fn unpack_part_to_file(src_path: &Path, dest_path: &Path) -> Result<u64, String> {
    unpack_part_to_file_with_chunk(src_path, dest_path, |_| {})
}

impl TelegramEngine {
    pub fn new(db: Arc<Database>, bot_api: Arc<BotApiProcess>) -> Self {
        let bot_api_url = bot_api.url.clone();
        let channel_id = crate::config::get_var("TELEGRAM_CHANNEL_ID")
            .unwrap_or_else(|| "-1004396487326".to_string());

        // Large local-Bot-API uploads can legitimately take a long time, so the
        // total timeout is generous while connection setup stays snappy.
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(3600))
            .build()
            .unwrap_or_default();

        TelegramEngine {
            client,
            db,
            bot_api_url,
            bot_api,
            channel_id,
        }
    }

    fn primary(&self) -> &str {
        &self.bot_api_url
    }

    fn bot_token(&self, part: &PartRecord) -> Result<String, String> {
        let state = self.db.state.read_safe();
        let bot = state.bots.iter().find(|b| b.id == part.bot_id)
            .or_else(|| state.bots.first());
        match bot {
            Some(bot) => Ok(bot.token.clone()),
            None => Err("No Telegram bot available".to_string()),
        }
    }

    async fn get_file_path(&self, token: &str, file_id: &str) -> Result<(String, String), String> {
        if file_id.starts_with("local:") {
            let path = self.db.local_path_for_file_id(file_id)
                .ok_or_else(|| "invalid local file id".to_string())?;
            if !path.exists() {
                return Err("local part is missing from the vault".to_string());
            }
            return Ok(("local".to_string(), path.to_string_lossy().to_string()));
        }
        self.bot_api.check_available()?;
        let primary = self.primary().to_string();
        let url = format!("{}/bot{}/getFile?file_id={}", primary, token, file_id);
        let res = self.client.get(&url).send().await
            .map_err(|_| "Self-hosted Bot API getFile request failed".to_string())?;

        if res.status().is_success() {
            let body_text = res.text().await.map_err(|e| e.to_string())?;
            let json: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| e.to_string())?;
            let file_path = json.get("result")
                .and_then(|r| r.get("file_path"))
                .and_then(|f| f.as_str())
                .ok_or("file_path not found in getFile result")?
                .to_string();
            return Ok((primary, file_path));
        }

        let body_text = res.text().await.unwrap_or_default();
        Err(format!("getFile failed: {}", body_text))
    }

    /// Fetch only the first bytes of a part. Thumbnails and metadata only
    /// need a small prefix, so never buffer a multi-gigabyte part for them.
    pub async fn fetch_part_prefix(&self, part: &PartRecord, max_bytes: usize) -> Result<Vec<u8>, String> {
        if let Some(path) = self.db.local_path_for_file_id(&part.telegram_file_id) {
            let file = tokio::fs::File::open(&path).await
                .map_err(|e| format!("cannot open local part: {}", e))?;
            let mut out = Vec::with_capacity(max_bytes.min(4 * 1024 * 1024));
            file.take(max_bytes as u64).read_to_end(&mut out).await
                .map_err(|e| format!("cannot read local part: {}", e))?;
            return Ok(strip_zip_header_if_present(out));
        }
        let token = self.bot_token(part)?;
        let (base_url, file_path) = self.get_file_path(&token, &part.telegram_file_id).await?;
        if Path::new(&file_path).is_absolute() {
            let file = tokio::fs::File::open(&file_path).await.map_err(|e| e.to_string())?;
            let mut out = Vec::with_capacity(max_bytes.min(4 * 1024 * 1024));
            file.take(max_bytes as u64).read_to_end(&mut out).await.map_err(|e| e.to_string())?;
            return Ok(strip_zip_header_if_present(out));
        }
        let dl_url = format!("{}/file/bot{}/{}", base_url, token, file_path);
        let mut res = self.client.get(&dl_url).send().await
            .map_err(|_| "Self-hosted Bot API download request failed".to_string())?;
        if !res.status().is_success() {
            return Err(format!("file download failed with HTTP {}", res.status()));
        }
        let mut out = Vec::with_capacity(max_bytes.min(4 * 1024 * 1024));
        while out.len() < max_bytes {
            let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? else {
                break;
            };
            let remaining = max_bytes - out.len();
            out.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        }
        Ok(strip_zip_header_if_present(out))
    }

    /// Stream every part directly into one local file with live chunk progress callbacks.
    /// Unpacks store-ZIP parts on the fly so the destination file matches the exact original uncompressed binary.
    /// Downloads parts[start_index..] into `dest`, appending. For a resume,
    /// `completed_bytes` is the exact size of the already-written prefix — the
    /// file is truncated to it so a half-written part is discarded, then each
    /// remaining part appends. `completed` is bumped once per finished part so
    /// callers can persist resume state.
    pub async fn download_parts_to_file_with_progress<F>(
        &self,
        parts: &[PartRecord],
        dest: &Path,
        cancel_flag: Option<Arc<std::sync::atomic::AtomicBool>>,
        pause_flag: Option<Arc<std::sync::atomic::AtomicBool>>,
        mut on_chunk: F,
        start_index: usize,
        completed_bytes: u64,
        completed: Option<Arc<std::sync::atomic::AtomicUsize>>,
    ) -> Result<u64, String>
    where
        F: FnMut(u64) + Send + 'static,
    {
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        if start_index > 0 {
            // Resume: keep completed whole parts, drop any partial tail.
            let file = std::fs::OpenOptions::new().write(true).open(dest)
                .map_err(|e| format!("cannot open resume target: {}", e))?;
            file.set_len(completed_bytes).map_err(|e| e.to_string())?;
        } else if !dest.exists() {
            let _ = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
        }
        let mut total = completed_bytes;
        let remaining_parts: Vec<PartRecord> = parts.iter().skip(start_index).cloned().collect();
        let total_parts = remaining_parts.len();
        if total_parts == 0 {
            return Ok(total);
        }

        // Pipelined lookahead prefetch slot for the next part (i + 1)
        let mut prefetch_slot: Option<(usize, tokio::task::JoinHandle<Result<(String, String), String>>)> = None;

        for (curr_seq, part) in remaining_parts.iter().enumerate() {
            if let Some(ref cf) = cancel_flag {
                if cf.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Some((_, h)) = prefetch_slot.take() { h.abort(); }
                    return Err("Cancelled".to_string());
                }
            }
            if let Some(ref pf) = pause_flag {
                if pf.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Some((_, h)) = prefetch_slot.take() { h.abort(); }
                    return Err("Paused".to_string());
                }
            }

            // Immediately launch prefetch for the next part in background
            let next_seq = curr_seq + 1;
            if next_seq < total_parts && prefetch_slot.is_none() {
                let next_p = remaining_parts[next_seq].clone();
                if !next_p.telegram_file_id.starts_with("local:") {
                    if let Ok(next_token) = self.bot_token(&next_p) {
                        let self_clone = self.clone();
                        let handle = tokio::spawn(async move {
                            self_clone.get_file_path(&next_token, &next_p.telegram_file_id).await
                        });
                        prefetch_slot = Some((next_seq, handle));
                    }
                }
            }

            if let Some(path) = self.db.local_path_for_file_id(&part.telegram_file_id) {
                let copied = unpack_part_to_file_with_chunk(&path, dest, &mut on_chunk)?;
                total += copied;
                if let Some(ref c) = completed { c.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
                continue;
            }

            // Check if current part was already prefetched in background
            let mut pending_handle = if let Some((seq, handle)) = prefetch_slot.take() {
                if seq == curr_seq {
                    Some(handle)
                } else {
                    prefetch_slot = Some((seq, handle));
                    None
                }
            } else {
                None
            };

            let token = self.bot_token(part)?;
            let bot_api_dir = self.db.data_dir.join("bot-api");
            let initial_bytes = get_bot_api_active_bytes(&bot_api_dir);

            // Live progress channel while Bot API downloads in the background
            let (tx_done, mut rx_done) = tokio::sync::oneshot::channel::<()>();
            let (tx_chunk, mut rx_chunk) = tokio::sync::mpsc::channel::<u64>(100);
            let bot_api_dir_clone = bot_api_dir.clone();
            let part_size = part.size;

            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(tokio::time::Duration::from_millis(50));
                let mut prev = initial_bytes;
                let mut accumulated = 0u64;
                let max_inflight = if part_size > 0 { (part_size as f64 * 0.75) as u64 } else { 0 };
                // Smooth incremental step for realistic progress display during Telegram Cloud fetch
                let smooth_step = ((part_size as f64 / 3.0) * 0.05).clamp(32768.0, 524288.0) as u64;

                loop {
                    tokio::select! {
                        _ = &mut rx_done => break,
                        _ = ticker.tick() => {
                            let curr = get_bot_api_active_bytes(&bot_api_dir_clone);
                            let delta = if curr > prev {
                                let d = curr - prev;
                                prev = curr;
                                d
                            } else {
                                // Dynamic progression if filesystem cache hasn't flushed
                                smooth_step
                            };

                            if accumulated < max_inflight && delta > 0 {
                                let capped = delta.min(max_inflight - accumulated);
                                accumulated += capped;
                                if capped > 0 {
                                    let _ = tx_chunk.send(capped).await;
                                }
                            }
                        }
                    }
                }
            });

            let mut part_downloaded = 0u64;
            let (base_url, file_path) = if let Some(mut h) = pending_handle.take() {
                let (b_url, f_path) = loop {
                    tokio::select! {
                        join_res = &mut h => {
                            let _ = tx_done.send(());
                            break join_res.map_err(|e| e.to_string())??;
                        }
                        Some(c) = rx_chunk.recv() => {
                            on_chunk(c);
                            part_downloaded += c;
                        }
                    }
                };
                while let Ok(c) = rx_chunk.try_recv() {
                    on_chunk(c);
                    part_downloaded += c;
                }
                (b_url, f_path)
            } else {
                let get_path_fut = self.get_file_path(&token, &part.telegram_file_id);
                tokio::pin!(get_path_fut);

                let (b_url, f_path) = loop {
                    tokio::select! {
                        res = &mut get_path_fut => {
                            let _ = tx_done.send(());
                            break res?;
                        }
                        Some(c) = rx_chunk.recv() => {
                            on_chunk(c);
                            part_downloaded += c;
                        }
                    }
                };

                while let Ok(c) = rx_chunk.try_recv() {
                    on_chunk(c);
                    part_downloaded += c;
                }
                (b_url, f_path)
            };

            if Path::new(&file_path).is_absolute() {
                let rem = part.size.saturating_sub(part_downloaded);
                let mut unpacked_so_far = 0u64;
                let mut emitted_unpack = 0u64;
                let copied = unpack_part_to_file_with_chunk(Path::new(&file_path), dest, |n| {
                    unpacked_so_far += n;
                    if part.size > 0 && rem > 0 {
                        let target_emit = ((unpacked_so_far as f64 / part.size as f64) * rem as f64) as u64;
                        if target_emit > emitted_unpack {
                            let delta = target_emit - emitted_unpack;
                            emitted_unpack += delta;
                            on_chunk(delta);
                        }
                    }
                })?;
                if rem > emitted_unpack {
                    on_chunk(rem - emitted_unpack);
                }
                total += copied;
                if let Some(ref c) = completed { c.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
                continue;
            }
            let token = self.bot_token(part)?;
            let dl_url = format!("{}/file/bot{}/{}", base_url, token, file_path);
            let mut res = self.client.get(&dl_url).send().await
                .map_err(|_| "Self-hosted Bot API download request failed".to_string())?;
            if !res.status().is_success() {
                return Err(format!("file download failed with HTTP {}", res.status()));
            }

            let temp_part_dest = dest.with_extension(format!("tmp-part-{}", part.part_index));
            {
                let mut temp_out = tokio::fs::File::create(&temp_part_dest).await.map_err(|e| e.to_string())?;
                while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
                    if let Some(ref cf) = cancel_flag {
                        if cf.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = tokio::fs::remove_file(&temp_part_dest).await;
                            return Err("Cancelled".to_string());
                        }
                    }
                    if let Some(ref pf) = pause_flag {
                        if pf.load(std::sync::atomic::Ordering::Relaxed) {
                            let _ = tokio::fs::remove_file(&temp_part_dest).await;
                            return Err("Paused".to_string());
                        }
                    }
                    let chunk_len = chunk.len() as u64;
                    temp_out.write_all(&chunk).await.map_err(|e| e.to_string())?;
                    // Fire progress callback with received network bytes for real-time live speed & progress
                    on_chunk(chunk_len);
                }
                temp_out.flush().await.map_err(|e| e.to_string())?;
            }

            // Unpack stored zip into final destination. We do not call on_chunk here
            // because network transfer progress was already emitted during download.
            let copied = unpack_part_to_file(&temp_part_dest, dest)?;
            let _ = tokio::fs::remove_file(&temp_part_dest).await;
            total += copied;
            if let Some(ref c) = completed { c.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
        }
        Ok(total)
    }

    /// Fetch ONE part's raw (unpacked) bytes into `dest`. In local mode the
    /// Bot API resolves getFile to an absolute path we can read directly —
    /// same absolute-path branch as the multi-part downloader.
    pub async fn download_single_part_to(&self, part: &PartRecord, dest: &Path) -> Result<u64, String> {
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        if let Some(path) = self.db.local_path_for_file_id(&part.telegram_file_id) {
            return unpack_part_to_file(&path, dest);
        }
        let token = self.bot_token(part)?;
        let (base_url, file_path) = self.get_file_path(&token, &part.telegram_file_id).await?;
        if Path::new(&file_path).is_absolute() {
            return unpack_part_to_file(Path::new(&file_path), dest);
        }
        let dl_url = format!("{}/file/bot{}/{}", base_url, token, file_path);
        let mut res = self.client.get(&dl_url).send().await
            .map_err(|_| "Self-hosted Bot API download request failed".to_string())?;
        if !res.status().is_success() {
            return Err(format!("file download failed with HTTP {}", res.status()));
        }
        let tmp = dest.with_extension("dl-tmp");
        {
            let mut out = tokio::fs::File::create(&tmp).await.map_err(|e| e.to_string())?;
            while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
                out.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            out.flush().await.map_err(|e| e.to_string())?;
        }
        let copied = unpack_part_to_file(&tmp, dest);
        let _ = tokio::fs::remove_file(&tmp).await;
        copied
    }

    /// Stream every part directly into one local file. Unpacks store-ZIP parts on the fly
    /// so the destination file matches the exact original uncompressed binary.
    pub async fn download_parts_to_file(&self, parts: &[PartRecord], dest: &Path) -> Result<u64, String> {
        self.download_parts_to_file_with_progress(parts, dest, None, None, |_| {}, 0, 0, None).await
    }

    /// Upload a file by streaming from disk (no full-file buffer in memory).
    pub async fn upload_document(
        &self,
        token: &str,
        chat_id: &str,
        filename: &str,
        path: &Path,
        caption: Option<&str>,
    ) -> Result<(i64, String), String> {
        self.bot_api.check_available()?;
        let primary_url = format!("{}/bot{}/sendDocument", self.primary(), token);

        let build = |url: String| {
            let path = path.to_path_buf();
            let filename = filename.to_string();
            let chat_id = chat_id.to_string();
            let caption = caption.map(|c| c.to_string());
            async move {
                let part = reqwest::multipart::Part::file(&path).await
                    .map_err(|e| format!("cannot open upload file: {}", e))?
                    .file_name(filename)
                    .mime_str("application/octet-stream")
                    .map_err(|e| e.to_string())?;
                let mut form = reqwest::multipart::Form::new()
                    .text("chat_id", chat_id)
                    .part("document", part);
                if let Some(cap) = caption {
                    form = form.text("caption", cap);
                }
                self.client.post(&url).multipart(form).send().await
                    .map_err(|_| "Self-hosted Bot API upload request failed".to_string())
            }
        };

        let res = build(primary_url).await?;
        let status = res.status();

        let body_text = res.text().await.map_err(|e| e.to_string())?;
        let json: serde_json::Value = match serde_json::from_str(&body_text) {
            Ok(value) => value,
            Err(_) => {
                // Keep the HTTP status in the message: a proxy-generated 413
                // may not be JSON, and the upload pipeline uses this text to
                // distinguish a permanent size rejection from a transient one.
                let snippet: String = body_text.chars().take(200).collect();
                return Err(format!("Telegram upload failed (HTTP {}): {}", status.as_u16(), snippet));
            }
        };

        if !json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let desc = json.get("description").and_then(|v| v.as_str()).unwrap_or("Telegram upload rejected");
            return Err(format!("{} (HTTP {})", desc, status.as_u16()));
        }

        let msg_id = json.get("result")
            .and_then(|r| r.get("message_id"))
            .and_then(|m| m.as_i64())
            .unwrap_or(0);

        let file_id = json.get("result")
            .and_then(|r| r.get("document"))
            .and_then(|d| d.get("file_id"))
            .and_then(|f| f.as_str())
            .ok_or("No document.file_id in Telegram response")?
            .to_string();

        Ok((msg_id, file_id))
    }

    /// Upload a local file by `file://` reference — the bundled Bot API reads
    /// the path itself, so no loopback body copy happens. B0 proved plain
    /// `file:///C:/...` (forward slashes, spaces allowed) works; non-ASCII
    /// basenames upload fine but Telegram records the display name mojibake'd,
    /// which is cosmetic since our DB name is authoritative.
    pub async fn upload_document_fileuri(
        &self,
        token: &str,
        chat_id: &str,
        path: &Path,
        caption: Option<&str>,
    ) -> Result<(i64, String), String> {
        self.bot_api.check_available()?;
        let uri = format!("file:///{}", path.display().to_string().replace('\\', "/"));
        let url = format!("{}/bot{}/sendDocument", self.primary(), token);
        let mut form: Vec<(String, String)> = vec![
            ("chat_id".to_string(), chat_id.to_string()),
            ("document".to_string(), uri),
        ];
        if let Some(cap) = caption {
            form.push(("caption".to_string(), cap.to_string()));
        }
        let res = self.client.post(&url).form(&form).send().await
            .map_err(|_| "Self-hosted Bot API upload request failed".to_string())?;
        let status = res.status();
        let body_text = res.text().await.map_err(|e| e.to_string())?;
        let json: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|_| format!("Telegram upload failed (HTTP {})", status.as_u16()))?;
        if !json.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            let desc = json.get("description").and_then(|v| v.as_str()).unwrap_or("Telegram upload rejected");
            return Err(format!("{} (HTTP {})", desc, status.as_u16()));
        }
        let msg_id = json.get("result")
            .and_then(|r| r.get("message_id"))
            .and_then(|m| m.as_i64())
            .unwrap_or(0);
        let file_id = json.get("result")
            .and_then(|r| r.get("document"))
            .and_then(|d| d.get("file_id"))
            .and_then(|f| f.as_str())
            .unwrap_or("")
            .to_string();
        if file_id.is_empty() {
            return Err("Telegram accepted the upload but returned no file_id".to_string());
        }
        Ok((msg_id, file_id))
    }

pub async fn delete_message(&self, token: &str, chat_id: &str, message_id: i64) -> Result<(), String> {
        if message_id < 0 {
            if let Some(path) = self.db.local_path_for_message_id(message_id) {
                match tokio::fs::remove_file(&path).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("cannot delete local part: {}", e)),
                }
            }
            return Ok(());
        }

        let token = if token.is_empty() || token == "local-vault" {
            self.db.any_bot_token().unwrap_or_default()
        } else {
            token.to_string()
        };
        if token.is_empty() {
            return Err("no Telegram bot token is configured".to_string());
        }
        self.bot_api.check_available()?;
        let url = format!("{}/bot{}/deleteMessage", self.primary(), token);
        let payload = serde_json::json!({
            "chat_id": chat_id,
            "message_id": message_id
        }).to_string();

        let res = self.client.post(&url)
            .header("content-type", "application/json")
            .body(payload)
            .send()
            .await
            .map_err(|_| "Self-hosted Bot API delete request failed".to_string())?;

        let body_text = res.text().await.unwrap_or_default();
        let body: serde_json::Value = serde_json::from_str(&body_text).unwrap_or(serde_json::Value::Null);
        if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            Ok(())
        } else {
            let desc = body.get("description").and_then(|v| v.as_str()).unwrap_or("deleteMessage failed");
            if desc.to_lowercase().contains("message to delete not found") {
                Ok(())
            } else {
                Err(desc.to_string())
            }
        }
    }

    pub async fn delete_messages(&self, token: &str, chat_id: &str, message_ids: &[i64]) -> Result<(), String> {
        if message_ids.is_empty() {
            return Ok(());
        }

        // Local vault parts use negative ids. Telegram message ids are positive.
        let (local, remote): (Vec<i64>, Vec<i64>) = message_ids.iter().copied()
            .partition(|&id| id < 0);
        for message_id in local {
            if let Some(path) = self.db.local_path_for_message_id(message_id) {
                match tokio::fs::remove_file(&path).await {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("cannot delete local part: {}", e)),
                }
            }
        }
        if remote.is_empty() {
            return Ok(());
        }

        let token = if token.is_empty() || token == "local-vault" {
            self.db.any_bot_token().unwrap_or_default()
        } else {
            token.to_string()
        };
        if token.is_empty() {
            return Err("no Telegram bot token is configured".to_string());
        }

        for chunk in remote.chunks(100) {
            let url = format!("{}/bot{}/deleteMessages", self.primary(), token);
            let payload = serde_json::json!({
                "chat_id": chat_id,
                "message_ids": chunk
            }).to_string();

            let res = self.client.post(&url)
                .header("content-type", "application/json")
                .body(payload)
                .send()
                .await;

            let mut batch_ok = false;
            if let Ok(r) = res {
                if let Ok(text) = r.text().await {
                    if let Ok(body) = serde_json::from_str::<serde_json::Value>(&text) {
                        if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                            batch_ok = true;
                        }
                    }
                }
            }

            if !batch_ok {
                let all_tokens: Vec<String> = {
                    let state = self.db.state.read_safe();
                    state.bots.iter().map(|b| b.token.clone()).collect()
                };
                for &mid in chunk {
                    let mut deleted = self.delete_message(&token, chat_id, mid).await.is_ok();
                    if !deleted {
                        for alt in &all_tokens {
                            if alt != &token {
                                if self.delete_message(alt, chat_id, mid).await.is_ok() {
                                    deleted = true;
                                    break;
                                }
                            }
                        }
                    }
                    if !deleted {
                        eprintln!("[TeleDrive] Failed to delete message {} from channel {}", mid, chat_id);
                    }
                }
            }
        }

        Ok(())
    }
}
