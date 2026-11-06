//! Progressive per-part streaming for Telegram-backed files. Each part is
//! cached on demand as `stream-<blobId>-p<idx>.bin` (the `stream-*` naming
//! keeps it under the LRU pruner); a Range request fetches only the parts it
//! touches and prefetch warms the next two parts ahead.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::models::PartRecord;
use crate::server::{AppServer, CacheUseGuard};
use crate::sync_ext::MutexExt;

/// Shared fetch-completion flag for a part download in flight.
pub struct PartFetch {
    pub done: AtomicBool,
    pub ok: AtomicBool,
}

/// Part index containing absolute byte `pos` (parts are contiguous in order).
pub fn part_index_at(parts: &[PartRecord], pos: u64) -> usize {
    let mut base = 0u64;
    for (i, p) in parts.iter().enumerate() {
        if pos < base + p.size {
            return i;
        }
        base += p.size;
    }
    parts.len().saturating_sub(1)
}

impl AppServer {
    fn stream_part_path(&self, blob_id: &str, idx: usize) -> PathBuf {
        self.get_cache_dir().join(format!("stream-{}-p{}.bin", blob_id, idx))
    }

    /// Make the unpacked bytes of `parts[idx]` available in the part cache.
    /// Concurrent callers for the same part share one fetch; the follower
    /// waits on the shared flag and re-checks the file afterwards.
    pub(crate) fn ensure_stream_part(
        &self,
        blob_id: &str,
        idx: usize,
        part: Option<&PartRecord>,
    ) -> Result<PathBuf, String> {
        let target = self.stream_part_path(blob_id, idx);
        let expected = part.map(|p| p.size).unwrap_or(0);
        if std::fs::metadata(&target).map(|m| m.len() == expected && expected > 0).unwrap_or(false) {
            Self::cache_touch(&target);
            return Ok(target);
        }
        let key = format!("{}:{}", blob_id, idx);
        let (fetch, mine) = {
            let mut map = self.part_inflight.lock_safe();
            match map.get(&key) {
                Some(f) => (Arc::clone(f), false),
                None => {
                    let f = Arc::new(PartFetch { done: AtomicBool::new(false), ok: AtomicBool::new(false) });
                    map.insert(key.clone(), Arc::clone(&f));
                    (f, true)
                }
            }
        };
        if !mine {
            while !fetch.done.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(10));
            }
            if fetch.ok.load(Ordering::Acquire)
                && std::fs::metadata(&target).map(|m| m.len() == expected).unwrap_or(false) {
                Self::cache_touch(&target);
                return Ok(target);
            }
            return Err("part fetch failed".to_string());
        }
        let result = (|| -> Result<PathBuf, String> {
            let part = part.ok_or_else(|| "part not found".to_string())?;
            let expected_size = part.size;
            let tmp = self.get_cache_dir().join(format!("stream-tmp-{}.bin", uuid::Uuid::new_v4()));
            let telegram = self.telegram.clone();
            let part_dl = part.clone();
            let tmp_dl = tmp.clone();
            let copied = self.tokio_runtime.block_on(async move {
                telegram.download_single_part_to(&part_dl, &tmp_dl).await
            })?;
            if copied != expected_size {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!("part size mismatch: got {}, expected {}", copied, expected_size));
            }
            std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
            Self::cache_touch(&target);
            Ok(target)
        })();
        let ok = result.is_ok();
        fetch.ok.store(ok, Ordering::Release);
        fetch.done.store(true, Ordering::Release);
        self.part_inflight.lock_safe().remove(&key);
        if ok {
            // Every completed cache file can push the pool over its limit.
            self.prune_stream_cache();
        }
        result
    }

    /// Warm the cache for the next `count` parts after `idx` — best effort,
    /// deduped by the in-flight map so repeated seeks never double-fetch.
    pub(crate) fn prefetch_stream_parts(&self, blob_id: &str, parts: &[PartRecord], idx: usize, count: usize) {
        for next in (idx + 1)..=(idx + count).min(parts.len().saturating_sub(1)) {
            let Some(part) = parts.get(next).cloned() else { break };
            let server = self.clone();
            let blob = blob_id.to_string();
            std::thread::spawn(move || {
                let _ = server.ensure_stream_part(&blob, next, Some(&part));
            });
        }
    }
}

/// Read adapter serving a byte range across the per-part cache. Blocks only
/// while the part currently being read is fetched; once a part opens, the
/// next two are prefetched so sequential playback rarely stalls.
pub struct PartChainReader {
    server: AppServer,
    blob_id: String,
    parts: Vec<PartRecord>,
    part_offsets: Vec<u64>,
    abs_pos: u64,
    cur_idx: usize,
    cur_file: Option<(std::fs::File, CacheUseGuard)>,
    failed: bool,
}

impl PartChainReader {
    pub fn new(server: AppServer, blob_id: String, parts: Vec<PartRecord>, start: u64) -> Self {
        let mut offsets = Vec::with_capacity(parts.len());
        let mut base = 0u64;
        for p in &parts {
            offsets.push(base);
            base += p.size;
        }
        Self {
            server,
            blob_id,
            parts,
            part_offsets: offsets,
            abs_pos: start,
            cur_idx: usize::MAX,
            cur_file: None,
            failed: false,
        }
    }

    fn open_current(&mut self) -> std::io::Result<()> {
        if self.cur_idx >= self.parts.len() {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "end of file"));
        }
        let part = self.parts[self.cur_idx].clone();
        let path = self.server
            .ensure_stream_part(&self.blob_id, self.cur_idx, Some(&part))
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let mut file = std::fs::File::open(&path)?;
        let intra = self.abs_pos.saturating_sub(self.part_offsets[self.cur_idx]);
        file.seek(SeekFrom::Start(intra))?;
        let guard = self.server.cache_acquire(&path);
        self.cur_file = Some((file, guard));
        self.server.prefetch_stream_parts(&self.blob_id, &self.parts, self.cur_idx, 2);
        Ok(())
    }
}

impl Read for PartChainReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.failed || buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.cur_file.is_none() {
                self.cur_idx = part_index_at(&self.parts, self.abs_pos);
                if self.cur_idx >= self.parts.len() {
                    return Ok(0);
                }
                if self.open_current().is_err() {
                    self.failed = true;
                    return Err(std::io::Error::new(std::io::ErrorKind::Other, "part fetch failed"));
                }
            }
            let Some((file, _)) = self.cur_file.as_mut() else { unreachable!() };
            match file.read(buf) {
                Ok(0) => {
                    self.cur_file = None;
                    self.cur_idx += 1;
                    if self.cur_idx >= self.parts.len() {
                        return Ok(0);
                    }
                }
                Ok(n) => {
                    self.abs_pos += n as u64;
                    return Ok(n);
                }
                Err(e) => return Err(e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_part(size: u64) -> PartRecord {
        PartRecord {
            id: "p".to_string(),
            blob_id: "b".to_string(),
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
    fn part_index_boundaries() {
        let parts = vec![dummy_part(100), dummy_part(200), dummy_part(300)];
        assert_eq!(part_index_at(&parts, 0), 0);
        assert_eq!(part_index_at(&parts, 50), 0);
        assert_eq!(part_index_at(&parts, 99), 0);
        assert_eq!(part_index_at(&parts, 100), 1);
        assert_eq!(part_index_at(&parts, 299), 1);
        assert_eq!(part_index_at(&parts, 300), 2);
        assert_eq!(part_index_at(&parts, 599), 2);
        assert_eq!(part_index_at(&parts, 1000), 2);
    }
}
