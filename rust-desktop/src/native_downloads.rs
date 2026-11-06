use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::Database;
use crate::telegram::TelegramEngine;
use crate::sync_ext::RwLockExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDownloadTask {
    pub id: String,
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub downloaded: u64,
    pub status: String, // "downloading" | "finalizing" | "paused" | "done" | "failed" | "cancelled"
    pub dest_path: String,
    pub speed: u64,
    pub eta: u64,
    pub error: Option<String>,
    pub created_at: i64,
    /// Partial-download staging file kept between pause and resume.
    #[serde(default)]
    pub tmp_path: String,
    /// Whole parts confirmed written to tmp_path — resume continues at this
    /// index (no byte-level resume inside a part).
    #[serde(default)]
    pub completed_parts: u64,
    /// Bytes of the completed-parts prefix; progress starts here on resume.
    #[serde(default)]
    pub completed_bytes: u64,
}

#[derive(Clone)]
pub struct NativeDownloadManager {
    pub tasks: Arc<RwLock<HashMap<String, NativeDownloadTask>>>,
    pauses: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    cancels: Arc<RwLock<HashMap<String, Arc<AtomicBool>>>>,
    db: Arc<Database>,
    telegram: Arc<TelegramEngine>,
    tokio_runtime: Arc<tokio::runtime::Runtime>,
}

impl NativeDownloadManager {
    pub fn new(
        db: Arc<Database>,
        telegram: Arc<TelegramEngine>,
        tokio_runtime: Arc<tokio::runtime::Runtime>,
    ) -> Self {
        let mgr = Self {
            tasks: Arc::new(RwLock::new(HashMap::new())),
            pauses: Arc::new(RwLock::new(HashMap::new())),
            cancels: Arc::new(RwLock::new(HashMap::new())),
            db,
            telegram,
            tokio_runtime,
        };
        // At startup nothing is active, so every leftover .teledrive-download
        // staging file is dead weight from a crash — remove all of them.
        mgr.sweep_tmp_downloads(None);
        mgr
    }

    /// Delete `.<name>-*.teledrive-download` staging files in the download dir.
    /// `older_than` limits the sweep to stale files; `None` deletes all matches
    /// regardless of age. Files referenced by an active task are never touched.
    pub fn sweep_tmp_downloads(&self, older_than: Option<std::time::Duration>) {
        let dir = self.get_download_dir();
        let active_tmps: std::collections::HashSet<String> = {
            let map = match self.tasks.read() { Ok(m) => m, Err(p) => p.into_inner() };
            map.values()
                .filter(|t| matches!(t.status.as_str(), "downloading" | "finalizing" | "paused" | "queued"))
                .map(|t| t.tmp_path.clone())
                .collect()
        };
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !(name.starts_with('.') && name.ends_with(".teledrive-download")) { continue; }
            let p = entry.path();
            if active_tmps.contains(&p.to_string_lossy().to_string()) { continue; }
            if let Some(age) = older_than {
                let stale = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .map(|e| e >= age)
                    .unwrap_or(false);
                if !stale { continue; }
            }
            let _ = std::fs::remove_file(&p);
        }
    }

    fn download_concurrency(&self) -> usize {
        let state = match self.db.state.read() { Ok(s) => s, Err(p) => p.into_inner() };
        (state.download_concurrency.clamp(1, 8)) as usize
    }

    fn active_count(&self) -> usize {
        let map = match self.tasks.read() { Ok(m) => m, Err(p) => p.into_inner() };
        map.values().filter(|t| matches!(t.status.as_str(), "downloading" | "finalizing")).count()
    }

    /// Promote queued tasks FIFO (by created_at) while a slot is free and
    /// spawn their workers. Call after every state transition that can free a
    /// slot or add a new queued task.
    pub fn pump_queue(&self) {
        loop {
            if self.active_count() >= self.download_concurrency() { return; }
            let next_id = {
                let map = match self.tasks.read() { Ok(m) => m, Err(p) => p.into_inner() };
                map.values()
                    .filter(|t| t.status == "queued")
                    .min_by_key(|t| t.created_at)
                    .map(|t| t.id.clone())
            };
            let Some(id) = next_id else { return };
            {
                let mut map = match self.tasks.write() { Ok(m) => m, Err(p) => p.into_inner() };
                if let Some(t) = map.get_mut(&id) {
                    if t.status != "queued" { continue; }
                    t.status = "downloading".to_string();
                } else { return; }
            }
            self.spawn_worker(&id);
        }
    }

    /// Resolve effective download directory (custom configured -> Windows Downloads -> home/Downloads -> current dir).
    pub fn get_download_dir(&self) -> PathBuf {
        let configured = {
            let state = self.db.state.read_safe();
            state.download_dir.clone()
        };
        if let Some(cfg) = configured {
            let p = PathBuf::from(cfg);
            if p.exists() || std::fs::create_dir_all(&p).is_ok() {
                return p;
            }
        }
        if let Some(d) = dirs::download_dir() {
            if d.exists() || std::fs::create_dir_all(&d).is_ok() {
                return d;
            }
        }
        if let Some(h) = dirs::home_dir() {
            let d = h.join("Downloads");
            let _ = std::fs::create_dir_all(&d);
            return d;
        }
        PathBuf::from(".")
    }

    /// Sanitize filename for Windows filesystem and resolve a non-colliding destination path.
    pub fn resolve_dest_path(&self, dir: &Path, file_name: &str) -> PathBuf {
        let clean: String = file_name
            .chars()
            .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\0') { '_' } else { c })
            .collect();
        let clean = clean.trim();
        let clean = if clean.is_empty() { "download" } else { clean };

        let candidate = dir.join(clean);
        if !candidate.exists() {
            return candidate;
        }

        let path = Path::new(clean);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("download");
        let ext = path.extension().and_then(|e| e.to_str());

        for i in 1..10000 {
            let new_name = match ext {
                Some(e) => format!("{} ({}).{}", stem, i, e),
                None => format!("{} ({})", stem, i),
            };
            let test_path = dir.join(&new_name);
            if !test_path.exists() {
                return test_path;
            }
        }
        dir.join(format!("{}-{}", clean, Uuid::new_v4().simple()))
    }

    /// Start downloading a file natively straight to the download directory.
    pub fn start_download(
        &self,
        file_id: &str,
        custom_name: Option<&str>,
    ) -> Result<NativeDownloadTask, String> {
        let (file, _parts) = {
            let state = self.db.state.read_safe();
            let f = state.files.iter().find(|x| x.id == file_id).cloned()
                .ok_or_else(|| "File not found".to_string())?;
            let mut p: Vec<_> = state.parts.iter().filter(|part| part.blob_id == f.blob_id).cloned().collect();
            p.sort_by_key(|k| k.part_index);
            (f, p)
        };
        let _ = &_parts;

        let download_dir = self.get_download_dir();
        let target_name = custom_name.unwrap_or(&file.name);
        let final_dest = self.resolve_dest_path(&download_dir, target_name);
        let task_id = Uuid::new_v4().to_string();

        let tmp_dest = download_dir.join(format!(
            ".{}-{}.teledrive-download",
            final_dest.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
            Uuid::new_v4().simple()
        ));

        let task = NativeDownloadTask {
            id: task_id.clone(),
            file_id: file.id.clone(),
            name: file.name.clone(),
            size: file.size,
            downloaded: 0,
            status: "queued".to_string(),
            dest_path: final_dest.to_string_lossy().to_string(),
            speed: 0,
            eta: 0,
            error: None,
            created_at: Utc::now().timestamp_millis(),
            tmp_path: tmp_dest.to_string_lossy().to_string(),
            completed_parts: 0,
            completed_bytes: 0,
        };

        // If file is 0 bytes, create empty file and complete immediately
        if file.size == 0 {
            let mut completed_task = task.clone();
            completed_task.status = "done".to_string();
            let _ = std::fs::File::create(&final_dest);
            self.tasks.write_safe().insert(task_id.clone(), completed_task.clone());
            return Ok(completed_task);
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let pause_flag = Arc::new(AtomicBool::new(false));

        self.cancels.write_safe().insert(task_id.clone(), Arc::clone(&cancel_flag));
        self.pauses.write_safe().insert(task_id.clone(), Arc::clone(&pause_flag));
        self.tasks.write_safe().insert(task_id.clone(), task.clone());

        // A free slot promotes this task to "downloading" and spawns it;
        // otherwise it stays "queued" until the pump reaches it.
        self.pump_queue();
        if let Some(t) = self.tasks.read_safe().get(&task_id) {
            return Ok(t.clone());
        }
        Ok(task)
    }

    /// Spawn the transfer worker for a task already marked "downloading".
    /// Re-reads the file/parts and the task's persisted resume point.
    fn spawn_worker(&self, task_id: &str) {
        let (file, parts, task) = {
            let state = match self.db.state.read() { Ok(s) => s, Err(p) => p.into_inner() };
            let map = match self.tasks.read() { Ok(m) => m, Err(p) => p.into_inner() };
            let Some(t) = map.get(task_id).cloned() else { return; };
            let Some(f) = state.files.iter().find(|x| x.id == t.file_id).cloned() else { return; };
            let mut p: Vec<_> = state.parts.iter().filter(|part| part.blob_id == f.blob_id).cloned().collect();
            p.sort_by_key(|k| k.part_index);
            (f, p, t)
        };
        let tmp_dest = PathBuf::from(&task.tmp_path);
        let final_dest = PathBuf::from(&task.dest_path);
        // Resume point: keep it only if the staging file still exists and is at
        // least as long as the completed-parts prefix.
        let (start_index, completed_bytes) = resume_point(
            &parts,
            task.completed_parts,
            tmp_dest.metadata().ok().map(|m| m.len()),
        );

        let cancel_flag = self.cancels.read_safe().get(task_id).cloned()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        let pause_flag = self.pauses.read_safe().get(task_id).cloned()
            .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
        self.cancels.write_safe().insert(task_id.to_string(), Arc::clone(&cancel_flag));
        self.pauses.write_safe().insert(task_id.to_string(), Arc::clone(&pause_flag));
        let completed_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let tasks_map = Arc::clone(&self.tasks);
        let telegram = Arc::clone(&self.telegram);
        let t_id = task_id.to_string();
        let expected_size = file.size;
        let mgr = self.clone();
        let completed_for_worker = Arc::clone(&completed_count);

        self.tokio_runtime.spawn(async move {
            let mut downloaded_bytes = completed_bytes;
            let mut last_emit = Instant::now();
            let mut last_bytes = 0u64;
            let mut smoothed_speed = 0.0f64;

            let tasks_for_progress = Arc::clone(&tasks_map);
            let t_id_progress = t_id.clone();

            let progress_fn = move |chunk_len: u64| {
                downloaded_bytes += chunk_len;
                let now = Instant::now();
                let elapsed = now.duration_since(last_emit).as_secs_f64();
                if elapsed >= 0.05 || downloaded_bytes >= expected_size {
                    let bytes_diff = downloaded_bytes.saturating_sub(last_bytes);
                    let inst_speed = if elapsed > 0.0 { bytes_diff as f64 / elapsed } else { 0.0 };
                    smoothed_speed = if smoothed_speed > 0.0 {
                        // gentler EMA so speed display is stable, not jittery
                        0.25 * inst_speed + 0.75 * smoothed_speed
                    } else {
                        inst_speed
                    };
                    last_emit = now;
                    last_bytes = downloaded_bytes;

                    // Cap at expected_size so the bar never exceeds 100%
                    let capped = downloaded_bytes.min(expected_size);
                    let remaining = expected_size.saturating_sub(capped);
                    let eta = if smoothed_speed > 1000.0 && remaining > 0 {
                        (remaining as f64 / smoothed_speed).ceil() as u64
                    } else {
                        0
                    };

                    let mut map = tasks_for_progress.write_safe();
                    if let Some(t) = map.get_mut(&t_id_progress) {
                        if t.status == "downloading" {
                            t.downloaded = capped;
                            t.speed = smoothed_speed.round() as u64;
                            t.eta = eta;
                        }
                    }
                }
            };

            let res = telegram.download_parts_to_file_with_progress(
                &parts,
                &tmp_dest,
                Some(cancel_flag),
                Some(pause_flag),
                progress_fn,
                start_index,
                completed_bytes,
                Some(completed_for_worker),
            ).await;

            let (status, downloaded, error) = match res {
                Ok(_total) => {
                    // Mark as 100% downloaded immediately so the bar hits 100%
                    // before the rename — preventing the "stuck at 99%" freeze.
                    {
                        let mut map = tasks_map.write_safe();
                        if let Some(t) = map.get_mut(&t_id) {
                            if t.status == "downloading" {
                                t.downloaded = expected_size;
                                t.speed = 0;
                                t.eta = 0;
                                t.status = "finalizing".to_string();
                            }
                        }
                    }
                    // If target file exists, remove it first so rename succeeds atomically in 0ms on Windows
                    if final_dest.exists() {
                        let _ = tokio::fs::remove_file(&final_dest).await;
                    }
                    // Move temp file to final destination
                    let move_ok = if tokio::fs::rename(&tmp_dest, &final_dest).await.is_err() {
                        if tokio::fs::copy(&tmp_dest, &final_dest).await.is_ok() {
                            let _ = tokio::fs::remove_file(&tmp_dest).await;
                            true
                        } else {
                            let _ = tokio::fs::remove_file(&tmp_dest).await;
                            false
                        }
                    } else {
                        true
                    };
                    if move_ok {
                        ("done".to_string(), expected_size, None)
                    } else {
                        ("failed".to_string(), 0, Some("Failed to move file to destination folder".to_string()))
                    }
                }
                Err(err) if err == "Cancelled" => {
                    let _ = tokio::fs::remove_file(&tmp_dest).await;
                    ("cancelled".to_string(), 0, None)
                }
                Err(err) if err == "Paused" => {
                    ("paused".to_string(), 0, None)
                }
                Err(err) => {
                    let _ = tokio::fs::remove_file(&tmp_dest).await;
                    ("failed".to_string(), 0, Some(err))
                }
            };

            let done_parts = completed_count.load(std::sync::atomic::Ordering::Relaxed);
            let finished_parts = start_index + done_parts;
            let done_bytes: u64 = parts.iter().take(finished_parts).map(|p| p.size).sum();
            {
                let mut map = tasks_map.write_safe();
                if let Some(t) = map.get_mut(&t_id) {
                    t.status = status;
                    if t.status == "done" {
                        t.downloaded = downloaded;
                    }
                    t.completed_parts = finished_parts as u64;
                    t.completed_bytes = done_bytes;
                    t.speed = 0;
                    t.eta = 0;
                    t.error = error;
                }
            }
            // A slot may have just opened — pull the next queued task.
            mgr.pump_queue();
        });
    }

    pub fn pause_download(&self, task_id: &str) -> Result<(), String> {
        if let Some(flag) = self.pauses.read_safe().get(task_id) {
            flag.store(true, Ordering::Relaxed);
        }
        {
            let mut map = self.tasks.write_safe();
            if let Some(t) = map.get_mut(task_id) {
                t.status = "paused".to_string();
                t.speed = 0;
                t.eta = 0;
            }
        }
        // Paused tasks don't hold a queue slot — promote the next one.
        self.pump_queue();
        Ok(())
    }

    pub fn cancel_download(&self, task_id: &str) -> Result<(), String> {
        if let Some(flag) = self.cancels.read_safe().get(task_id) {
            flag.store(true, Ordering::Relaxed);
        }
        let mut was_idle = false;
        {
            let mut map = self.tasks.write_safe();
            if let Some(t) = map.get_mut(task_id) {
                // A queued or paused task has no running worker to remove its
                // staging file — do it here.
                was_idle = matches!(t.status.as_str(), "queued" | "paused");
                t.status = "cancelled".to_string();
                t.speed = 0;
                t.eta = 0;
                if was_idle && !t.tmp_path.is_empty() {
                    let _ = std::fs::remove_file(&t.tmp_path);
                }
            }
        }
        if was_idle {
            self.pump_queue();
        }
        Ok(())
    }

    /// Resume keeps the same task id: it rejoins the queue and continues from
    /// the last completed part when a slot opens.
    pub fn resume_download(&self, task_id: &str) -> Result<(), String> {
        {
            let mut map = self.tasks.write_safe();
            let t = map.get_mut(task_id).ok_or_else(|| "Task not found".to_string())?;
            if !matches!(t.status.as_str(), "paused" | "failed" | "cancelled") {
                return Err("Task is not paused".to_string());
            }
            t.status = "queued".to_string();
            t.error = None;
        }
        if let Some(flag) = self.pauses.read_safe().get(task_id) {
            flag.store(false, Ordering::Relaxed);
        }
        if let Some(flag) = self.cancels.read_safe().get(task_id) {
            flag.store(false, Ordering::Relaxed);
        }
        self.pump_queue();
        Ok(())
    }

    pub fn open_file(&self, task_id: &str) -> Result<(), String> {
        let path_str = {
            let map = self.tasks.read_safe();
            let t = map.get(task_id).ok_or_else(|| "Download task not found".to_string())?;
            t.dest_path.clone()
        };
        let path = PathBuf::from(&path_str);
        if !path.exists() {
            return Err(format!("File does not exist: {}", path.display()));
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            std::process::Command::new("cmd.exe")
                .args(&["/C", "start", "", &path.to_string_lossy()])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to open file: {}", e))?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(&path).spawn()
                .map_err(|e| format!("Failed to open file: {}", e))?;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(&path).spawn()
                .map_err(|e| format!("Failed to open file: {}", e))?;
        }
        Ok(())
    }

    pub fn reveal_file(&self, task_id: &str) -> Result<(), String> {
        let path_str = {
            let map = self.tasks.read_safe();
            let t = map.get(task_id).ok_or_else(|| "Download task not found".to_string())?;
            t.dest_path.clone()
        };
        let path = PathBuf::from(&path_str);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            if path.exists() {
                std::process::Command::new("explorer.exe")
                    .arg(format!("/select,\"{}\"", path.display()))
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map_err(|e| format!("Failed to reveal file: {}", e))?;
            } else if let Some(parent) = path.parent() {
                std::process::Command::new("explorer.exe")
                    .arg(parent)
                    .creation_flags(CREATE_NO_WINDOW)
                    .spawn()
                    .map_err(|e| format!("Failed to open directory: {}", e))?;
            }
        }
        #[cfg(target_os = "macos")]
        {
            if path.exists() {
                std::process::Command::new("open").args(&["-R", &path.to_string_lossy()]).spawn()
                    .map_err(|e| format!("Failed to reveal file: {}", e))?;
            }
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            if let Some(parent) = path.parent() {
                std::process::Command::new("xdg-open").arg(parent).spawn()
                    .map_err(|e| format!("Failed to open directory: {}", e))?;
            }
        }
        Ok(())
    }

    pub fn pick_download_folder(&self) -> Result<Option<String>, String> {
        let folder = rfd::FileDialog::new().pick_folder();
        if let Some(p) = folder {
            let path_str = p.to_string_lossy().to_string();
            {
                let mut state = self.db.state.write_safe();
                state.download_dir = Some(path_str.clone());
            }
            self.db.save();
            return Ok(Some(path_str));
        }
        Ok(None)
    }

    pub fn list_downloads(&self) -> (Vec<NativeDownloadTask>, String) {
        let mut list: Vec<NativeDownloadTask> = self.tasks.read_safe().values().cloned().collect();
        list.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let dir = self.get_download_dir().to_string_lossy().to_string();
        (list, dir)
    }

    pub fn clear_done(&self) {
        let mut map = self.tasks.write_safe();
        map.retain(|_, t| matches!(t.status.as_str(), "downloading" | "finalizing" | "paused" | "queued"));
    }

    pub fn remove_task(&self, task_id: &str) {
        let _ = self.cancel_download(task_id);
        if let Some(t) = self.tasks.write_safe().remove(task_id) {
            if !t.tmp_path.is_empty() {
                let _ = std::fs::remove_file(&t.tmp_path);
            }
        }
        self.pauses.write_safe().remove(task_id);
        self.cancels.write_safe().remove(task_id);
        self.pump_queue();
    }
}


/// Where a resumed download continues: `Some(tmp_len)` must cover the exact
/// byte length of the completed-parts prefix, otherwise we start over so a
/// torn staging file can never produce a corrupt result.
fn resume_point(
    parts: &[crate::models::PartRecord],
    completed_parts: u64,
    tmp_len: Option<u64>,
) -> (usize, u64) {
    let base: u64 = parts.iter().take(completed_parts as usize).map(|p| p.size).sum();
    let ok = completed_parts > 0 && tmp_len.map(|l| l >= base).unwrap_or(false);
    if ok { (completed_parts as usize, base) } else { (0, 0) }
}

#[cfg(test)]
mod tests {
    use super::resume_point;
    use crate::models::PartRecord;

    fn part(size: u64) -> PartRecord {
        PartRecord {
            id: String::new(),
            blob_id: String::new(),
            part_index: 0,
            size,
            sha256: String::new(),
            telegram_file_id: String::new(),
            telegram_message_id: 0,
            telegram_channel_id: String::new(),
            bot_id: String::new(),
            created_at: 0,
        }
    }

    #[test]
    fn resume_keeps_completed_parts_when_tmp_intact() {
        let parts = vec![part(100), part(200), part(50)];
        // 2 parts done (300 bytes), tmp holds at least that → continue at #2.
        assert_eq!(resume_point(&parts, 2, Some(400)), (2, 300));
    }

    #[test]
    fn resume_restarts_when_tmp_missing_or_short() {
        let parts = vec![part(100), part(200)];
        assert_eq!(resume_point(&parts, 1, None), (0, 0));
        assert_eq!(resume_point(&parts, 1, Some(50)), (0, 0));
        assert_eq!(resume_point(&parts, 0, Some(999)), (0, 0));
    }
}
