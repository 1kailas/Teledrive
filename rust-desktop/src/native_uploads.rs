//! Native direct-from-disk uploads. The browser pipeline owns everything
//! after a part's bytes are staged; this module only replaces "browser sends
//! slices" with a feeder that copies byte ranges from the source file into the
//! staged part files and marks their slices received.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use chrono::Utc;
use uuid::Uuid;

use crate::server::{ActiveUploadSession, ActiveUploadPart, AppServer};
use crate::sync_ext::{MutexExt, RwLockExt};

pub struct NativeUploadOutcome {
    pub uploads: Vec<serde_json::Value>,
    pub skipped: Vec<serde_json::Value>,
}

impl AppServer {
    /// Staging back-pressure: at most (telegram upload slots + 1) staged-but-
    /// unstored parts may exist at once, bounding temp disk use.
    fn native_stage_limit(&self) -> usize {
        let state = self.db.state.read_safe();
        (state.bots.len() * state.bot_max_concurrent_uploads as usize).max(1) + 1
    }

    /// Validate + build a native session for one path. Err(reason) becomes a
    /// `skipped` entry in the API response.
    pub fn create_native_session(
        &self,
        path_str: &str,
        folder_id: Option<String>,
        conflict: &str,
    ) -> Result<ActiveUploadSession, String> {
        let path = Path::new(path_str);
        if !path.is_absolute() {
            return Err("path is not absolute".to_string());
        }
        let meta = std::fs::metadata(path).map_err(|_| "file does not exist or is not readable".to_string())?;
        if meta.is_dir() {
            return Err("folders are not supported yet".to_string());
        }
        if !meta.is_file() {
            return Err("not a regular file".to_string());
        }
        // Same source already in flight?
        {
            let uploads = self.active_uploads.read_safe();
            let canon = path.to_string_lossy().to_string().to_lowercase();
            if uploads.values().any(|s| {
                s.source_path.as_deref().map(|p| p.to_lowercase()) == Some(canon.clone())
            }) {
                return Err("already uploading".to_string());
            }
        }
        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let size = meta.len();
        let mime_type = mime_guess::from_path(&name).first_or_octet_stream().to_string();
        let mtime_ms = meta.modified().ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        // Name conflict against an existing live file in the target folder.
        {
            let state = self.db.state.read_safe();
            let taken = state.files.iter().find(|f| {
                f.trashed_at.is_none()
                    && f.folder_id == folder_id
                    && f.name.eq_ignore_ascii_case(&name)
            }).cloned();
            drop(state);
            if let Some(existing) = taken {
                match conflict {
                    "error" => return Err("a file with this name already exists".to_string()),
                    "replace" => {
                        let mut state = self.db.state.write_safe();
                        if let Some(f) = state.files.iter_mut().find(|f| f.id == existing.id) {
                            f.trashed_at = Some(Utc::now().timestamp_millis());
                        }
                        drop(state);
                        self.db.save();
                    }
                    _ => {} // "rename" — finalize_upload's unique_file_name handles it
                }
            }
        }

        // Same 507 disk-space guard as browser uploads.
        if size > 0 {
            let (free, total) = self.db.disk_space();
            const DISK_RESERVE: u64 = 64 * 1024 * 1024;
            let staged_need = size.min(self.native_stage_limit() as u64
                * self.part_size_for(&mime_type) * 1024 * 1024);
            if total > 0 && free < staged_need.saturating_add(DISK_RESERVE) {
                return Err(format!(
                    "not enough free disk space: {} needed, {} available",
                    crate::server::human_bytes(staged_need + DISK_RESERVE),
                    crate::server::human_bytes(free)
                ));
            }
        }

        let part_size = self.part_size_for(&mime_type) * 1024 * 1024;
        let slice_mb = self.db.state.read_safe().slice_size_mb.clamp(1, 256);
        let slice_size = (slice_mb * 1024 * 1024).min(part_size).max(1);
        let part_count = if size == 0 { 0 } else { size.div_ceil(part_size) as usize };
        let mut parts = Vec::with_capacity(part_count);
        let mut offset = 0u64;
        for idx in 0..part_count {
            let psize = (size - offset).min(part_size);
            parts.push(ActiveUploadPart {
                idx,
                offset,
                size: psize,
                slice_count: psize.div_ceil(slice_size).max(1) as usize,
                status: "pending".to_string(),
                received_slices: Vec::new(),
                attempts: 0,
                telegram_file_id: None,
                telegram_message_id: None,
                bot_id: None,
                sha256: String::new(),
                started_at: None,
                last_error: None,
            });
            offset += psize;
        }

        // Read first few MB for metadata extraction & thumbnail generation
        let preview_bytes = if let Ok(mut f) = std::fs::File::open(path) {
            let mut buf = vec![0u8; (4 * 1024 * 1024).min(size as usize)];
            let n = f.read(&mut buf).unwrap_or(0);
            buf.truncate(n);
            if !buf.is_empty() {
                Some(buf)
            } else {
                None
            }
        } else {
            None
        };

        let session = ActiveUploadSession {
            id: Uuid::new_v4().to_string(),
            file_id: Uuid::new_v4().to_string(),
            blob_id: Uuid::new_v4().to_string(),
            name,
            size,
            mime_type,
            folder_id,
            part_size,
            slice_size,
            client_key: Some(format!("native|{}", path_str)),
            parts,
            created_at: Utc::now().timestamp_millis(),
            status: "active".to_string(),
            preview: preview_bytes,
            source_path: Some(path.to_string_lossy().to_string()),
            source_size: Some(size),
            source_mtime: Some(mtime_ms),
        };
        Ok(session)
    }

    /// Copy a part's byte range from the source into its staged part file.
    fn stage_native_part(&self, session: &ActiveUploadSession, part_idx: usize) -> Result<(), String> {
        let part = session.parts.get(part_idx).ok_or("part not found")?;
        let src = session.source_path.as_ref().ok_or("not a native session")?;
        let mut input = std::fs::File::open(src)
            .map_err(|e| format!("cannot open source file: {}", e))?;
        input.seek(SeekFrom::Start(part.offset)).map_err(|e| e.to_string())?;
        let dest = self.part_file(&session.id, part_idx);
        if let Some(parent) = dest.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
        let mut remaining = part.size;
        let mut buf = vec![0u8; 256 * 1024];
        while remaining > 0 {
            let want = remaining.min(buf.len() as u64) as usize;
            let n = input.read(&mut buf[..want])
                .map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("source file shrank mid-upload".to_string());
            }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            remaining -= n as u64;
        }
        Ok(())
    }

    /// Spawn the feeder for a session — no-op when one is already running, so
    /// retries can never double-feed an upload.
    pub fn spawn_native_feeder(&self, upload_id: String) {
        if !self.native_feeders.lock_safe().insert(upload_id.clone()) {
            return;
        }
        let server = self.clone();
        let uid = upload_id.clone();
        std::thread::spawn(move || {
            server.run_native_feeder(uid.clone());
            server.native_feeders.lock_safe().remove(&uid);
        });
    }

    /// Re-verify the source file still matches the recorded size+mtime —
    /// restaging against a changed file would corrupt the upload.
    fn native_source_valid(&self, session: &ActiveUploadSession) -> bool {
        let Some(src) = session.source_path.as_deref() else { return false };
        std::fs::metadata(src).ok()
            .map(|m| m.is_file()
                && m.len() == session.source_size.unwrap_or(0)
                && m.modified().ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64) == session.source_mtime)
            .unwrap_or(false)
    }

    /// Feeder: every non-stored part gets (re)staged from the source and
    /// handed to the claim→send pipeline. A part whose slices are already
    /// recorded but whose staged file is missing is restaged the same way —
    /// this is also what makes retry work after a crash or cleanup.
    pub fn run_native_feeder(&self, upload_id: String) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let limit = self.native_stage_limit();
            loop {
                let snapshot = {
                    let map = self.active_uploads.read_safe();
                    map.get(&upload_id).cloned()
                };
                let Some(session) = snapshot else { return; };
                if Self::session_status(&session) == "failed" { return; }
                let next = session.parts.iter().find(|p| p.status == "pending")
                    .map(|p| p.idx);
                let Some(idx) = next else {
                    // Nothing left to send. If every part is already durable in
                    // Telegram, the previous process may have stopped between
                    // "last part stored" and "file record written".
                    if !session.parts.is_empty()
                        && session.parts.iter().all(|p| p.status == "stored")
                        && self.try_begin_finalize(&upload_id)
                    {
                        let _ = self.finalize_and_drop(&upload_id);
                    }
                    return;
                };
                let part = session.parts.get(idx).unwrap();
                let staged = part.received_slices.len() >= part.slice_count
                    && self.part_file(&upload_id, idx).exists();
                if !staged {
                    // Wait until fewer than `limit` staged-but-unstored parts exist.
                    let staged_ahead = session.parts.iter().filter(|p| {
                        p.status != "stored" && p.received_slices.len() >= p.slice_count
                    }).count();
                    if staged_ahead >= limit {
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        continue;
                    }
                    if !self.native_source_valid(&session) {
                        let lock = self.upload_lock(&upload_id);
                        let _guard = lock.lock_safe();
                        if let Some(cur) = self.active_uploads.write_safe().get_mut(&upload_id) {
                            if let Some(p) = cur.parts.get_mut(idx) {
                                p.status = "failed".to_string();
                                p.last_error = Some("source file changed or missing".to_string());
                            }
                        }
                        self.persist_session_by_id(&upload_id);
                        return;
                    }
                    if let Err(e) = self.stage_native_part(&session, idx) {
                        let lock = self.upload_lock(&upload_id);
                        let _guard = lock.lock_safe();
                        if let Some(cur) = self.active_uploads.write_safe().get_mut(&upload_id) {
                            if let Some(p) = cur.parts.get_mut(idx) {
                                p.status = "failed".to_string();
                                p.last_error = Some(e);
                            }
                        }
                        self.persist_session_by_id(&upload_id);
                        return;
                    }
                    {
                        let lock = self.upload_lock(&upload_id);
                        let _guard = lock.lock_safe();
                        let mut map = self.active_uploads.write_safe();
                        let Some(cur) = map.get_mut(&upload_id) else { return };
                        let Some(p) = cur.parts.get_mut(idx) else { return };
                        if p.status == "stored" { continue; }
                        p.received_slices = (0..p.slice_count).collect();
                    }
                }
                // Same dispatch as the slice route: claim then send in a worker.
                let server = self.clone();
                let uid = upload_id.clone();
                std::thread::spawn(move || {
                    let body = std::panic::AssertUnwindSafe(|| {
                        match server.claim_part_wait(&uid, idx) {
                            Ok(Some(claimed)) => {
                                let send_failed = match server.send_part(&claimed, idx) {
                                    Ok(()) => false,
                                    Err(e) => {
                                        eprintln!("[TeleDrive] Native part upload failed for {} part {}: {}", uid, idx, e);
                                        true
                                    }
                                };
                                let (all_stored, part_failed, attempts) = {
                                    let map = server.active_uploads.read_safe();
                                    map.get(&uid).map(|s| {
                                        (
                                            s.parts.iter().all(|p| p.status == "stored"),
                                            s.parts.get(idx).map(|p| p.status == "failed").unwrap_or(false),
                                            s.parts.get(idx).map(|p| p.attempts).unwrap_or(0),
                                        )
                                    }).unwrap_or((false, false, 0))
                                };
                                if all_stored {
                                    if server.try_begin_finalize(&uid) {
                                        let _ = server.finalize_and_drop(&uid);
                                    }
                                } else {
                                    // The feeder may have exited while this
                                    // worker was sending. Restart it so a
                                    // transient failure is retried instead of
                                    // leaving the upload paused forever, with a
                                    // short backoff so a brief Bot API restart
                                    // does not burn every attempt instantly.
                                    if send_failed && !part_failed {
                                        let delay = (attempts as u64 * 2).clamp(1, 30);
                                        std::thread::sleep(std::time::Duration::from_secs(delay));
                                    }
                                    server.spawn_native_feeder(uid.clone());
                                }
                            }
                            Ok(None) => {}
                            Err(e) => {
                                eprintln!("[TeleDrive] Native part claim failed for {} part {}: {}", uid, idx, e);
                                server.spawn_native_feeder(uid.clone());
                            }
                        }
                    });
                    let _ = std::panic::catch_unwind(body);
                });
            }
        }));
    }

    /// Startup auto-resume: persisted native sessions continue if the source
    /// file is byte-identical (size + mtime); otherwise they fail loudly.
    pub fn start_native_feeders(&self) {
        let sessions: Vec<ActiveUploadSession> = {
            let map = self.active_uploads.read_safe();
            map.values().filter(|s| s.source_path.is_some()).cloned().collect()
        };
        for mut session in sessions {
            let src = session.source_path.clone().unwrap_or_default();
            let ok = std::fs::metadata(&src).ok()
                .map(|m| m.is_file()
                    && m.len() == session.source_size.unwrap_or(0)
                    && m.modified().ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as i64) == session.source_mtime)
                .unwrap_or(false);
            if !ok {
                let lock = self.upload_lock(&session.id);
                let _guard = lock.lock_safe();
                if let Some(cur) = self.active_uploads.write_safe().get_mut(&session.id) {
                    for p in &mut cur.parts {
                        if p.status != "stored" {
                            p.status = "failed".to_string();
                            p.last_error = Some("source file changed or missing".to_string());
                        }
                    }
                }
                self.persist_session_by_id(&session.id);
                session.status = "failed".to_string();
                continue;
            }
            // Parts that were pending when the app died lost their staged file
            // (load_persisted_uploads already cleared their slices) — the
            // feeder restages them; stored parts are skipped automatically.
            self.spawn_native_feeder(session.id.clone());
        }
    }

    /// Shared handler for POST /api/native-uploads (+/pick with chosen paths).
    pub fn create_native_uploads(
        &self,
        paths: Vec<String>,
        folder_id: Option<String>,
        conflict: &str,
    ) -> NativeUploadOutcome {
        let mut uploads = Vec::new();
        let mut skipped = Vec::new();
        for path_str in paths {
            match self.create_native_session(&path_str, folder_id.clone(), conflict) {
                Ok(session) => {
                    let upload_id = session.id.clone();
                    self.active_uploads.write_safe().insert(upload_id.clone(), session.clone());
                    self.persist_session(&session);
                    if session.size == 0 {
                        // Empty files can't go to Telegram — finalize now.
                        match self.finalize_upload(&session) {
                            Ok(file) => {
                                uploads.push(serde_json::json!({
                                    "uploadId": upload_id, "name": session.name, "size": 0,
                                    "file": file, "complete": true
                                }));
                                self.drop_upload(&upload_id);
                            }
                            Err(e) => {
                                skipped.push(serde_json::json!({"path": path_str, "reason": e}));
                                self.drop_upload(&upload_id);
                            }
                        }
                        continue;
                    }
                    let _ = std::fs::create_dir_all(self.upload_dir(&upload_id));
                    self.spawn_native_feeder(upload_id.clone());
                    uploads.push(serde_json::json!({
                        "uploadId": upload_id,
                        "name": session.name,
                        "size": session.size
                    }));
                }
                Err(reason) => {
                    skipped.push(serde_json::json!({"path": path_str, "reason": reason}));
                }
            }
        }
        NativeUploadOutcome { uploads, skipped }
    }

    /// True while any upload has unstored parts or any download is active —
    /// used by the window-close/tray logic.
    #[allow(dead_code)]
    pub fn has_active_transfers(&self) -> bool {
        let uploading = {
            let map = self.active_uploads.read_safe();
            map.values().any(|s| s.parts.iter().any(|p| p.status != "stored" && p.status != "failed"))
        };
        if uploading { return true; }
        let downloads = self.native_downloads.tasks.read_safe();
        downloads.values().any(|t| matches!(t.status.as_str(), "queued" | "downloading" | "finalizing"))
    }
}
