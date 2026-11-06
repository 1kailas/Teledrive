use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::models::*;
use crate::sync_ext::RwLockExt;

pub fn default_part_size_mb() -> u64 { 512 }
pub fn default_slice_size_mb() -> u64 { 32 }
pub fn default_client_upload_concurrency() -> u64 { 4 }
pub fn default_telegram_upload_concurrency() -> u64 { 0 }
pub fn default_bot_max_concurrent_uploads() -> u64 { 2 }
pub fn default_storage_mode() -> String { "telegram".to_string() }
pub fn default_local_mirror_path() -> Option<String> { None }
pub fn default_local_mirror_enabled() -> bool { false }
pub fn default_download_concurrency() -> u64 { 3 }
pub fn default_cache_limit_gb() -> u64 { 10 }
/// Trashed items are removed automatically after this many days.
pub const TRASH_RETENTION_DAYS: i64 = 30;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PartDeletionTarget {
    pub bot_id: String,
    pub channel_id: String,
    pub message_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseState {
    pub files: Vec<FileRecord>,
    pub folders: Vec<FolderRecord>,
    pub blobs: Vec<BlobRecord>,
    pub parts: Vec<PartRecord>,
    pub bots: Vec<BotRecord>,
    /// Legacy "local" is retained only to read old files; new uploads always
    /// use the Telegram channel.
    #[serde(default = "default_storage_mode")]
    pub storage_mode: String,
    /// Set once the one-time move from the old "local" default to Telegram ran.
    #[serde(default)]
    pub storage_migrated: bool,
    #[serde(default = "default_part_size_mb")]
    pub part_size_mb: u64,
    #[serde(default = "default_slice_size_mb")]
    pub slice_size_mb: u64,
    #[serde(default = "default_client_upload_concurrency")]
    pub client_upload_concurrency: u64,
    #[serde(default = "default_telegram_upload_concurrency")]
    pub telegram_upload_concurrency: u64,
    #[serde(default = "default_bot_max_concurrent_uploads")]
    pub bot_max_concurrent_uploads: u64,
    #[serde(default)]
    pub admin_password: Option<String>,
    #[serde(default = "default_local_mirror_path")]
    pub local_mirror_path: Option<String>,
    #[serde(default = "default_local_mirror_enabled")]
    pub local_mirror_enabled: bool,
    #[serde(default)]
    pub download_dir: Option<String>,
    #[serde(default = "default_download_concurrency")]
    pub download_concurrency: u64,
    #[serde(default = "default_cache_limit_gb")]
    pub cache_limit_gb: u64,
    /// Orphaned blobs that the startup Telegram recovery has already inspected.
    /// Kept so a channel full of superseded retry uploads is not re-scanned (and
    /// temporarily forwarded) on every launch.
    #[serde(default)]
    pub recovery_scanned_blobs: Vec<String>,
}

pub struct Database {
    pub data_dir: PathBuf,
    pub thumbnails_dir: PathBuf,
    pub cache_dir: PathBuf,
    /// Built-in local storage. Documents live here when storage_mode is local.
    pub vault_dir: PathBuf,
    pub vault_files_dir: PathBuf,
    /// Local database snapshots created by the Backups tab.
    pub backups_dir: PathBuf,
    pub state_file: PathBuf,
    pub state: Arc<RwLock<DatabaseState>>,
    pub start_time: i64,
}

/// Free and total bytes of the volume that holds `path`.
/// `(0, 0)` means the platform could not report the values.
pub fn disk_space_for(path: &Path) -> (u64, u64) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut u64,
                lpTotalNumberOfBytes: *mut u64,
                lpTotalNumberOfFreeBytes: *mut u64,
            ) -> i32;
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let mut free = 0u64;
        let mut total = 0u64;
        let mut total_free = 0u64;
        let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut total_free) };
        if ok != 0 && total > 0 {
            return (free, total);
        }
        return (0, 0);
    }
    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
            return (0, 0);
        };
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        let ok = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
        if ok == 0 {
            let block = if stat.f_frsize > 0 { stat.f_frsize } else { stat.f_bsize } as u64;
            let free = (stat.f_bavail as u64).saturating_mul(block);
            let total = (stat.f_blocks as u64).saturating_mul(block);
            if total > 0 {
                return (free, total);
            }
        }
        return (0, 0);
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = path;
        (0, 0)
    }
}

/// `report.pdf` -> `report (copy).pdf`, matching the UI's duplicate naming.
fn append_copy_suffix(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} (copy){}", &name[..dot], &name[dot..]),
        _ => format!("{} (copy)", name),
    }
}

/// Turn a file/folder name into a safe ZIP path component.
fn zip_safe_component(name: &str) -> String {
    let cleaned: String = name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "unnamed".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Make a ZIP path unique on a case-insensitive filesystem.
fn unique_zip_path(used: &mut std::collections::HashSet<String>, path: &str) -> String {
    if used.insert(path.to_lowercase()) {
        return path.to_string();
    }
    let slash = path.rfind('/').map(|i| i + 1).unwrap_or(0);
    let (stem, ext) = match path.rfind('.') {
        Some(dot) if dot > slash => (&path[..dot], &path[dot..]),
        _ => (path, ""),
    };
    for n in 1u32.. {
        let candidate = format!("{} ({}){}", stem, n, ext);
        if used.insert(candidate.to_lowercase()) {
            return candidate;
        }
    }
    unreachable!()
}

impl Database {
    pub fn init() -> Self {
        let base_dir = if let Some(app_data) = dirs::data_dir() {
            app_data.join("TeleDrive")
        } else {
            PathBuf::from("data")
        };

        let data_dir = base_dir.join("data");
        let thumbnails_dir = data_dir.join("thumbnails");
        let _ = fs::create_dir_all(&thumbnails_dir);

        // Built-in local vault. Kept inside the app data directory so the app
        // remains a single self-contained install with no external services.
        let vault_dir = data_dir.join("vault");
        let vault_files_dir = vault_dir.join("files");
        let _ = fs::create_dir_all(&vault_files_dir);
        let backups_dir = data_dir.join("backups");
        let _ = fs::create_dir_all(&backups_dir);
        // Leftover staging dirs from interrupted uploads must not grow forever.
        let uploads_dir = data_dir.join("uploads");
        let _ = fs::create_dir_all(&uploads_dir);
        if let Ok(entries) = fs::read_dir(&uploads_dir) {
            let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 3600);
            for entry in entries.flatten() {
                let stale = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .map(|m| m < cutoff)
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        // Temporary download files are deleted after each response. Sweep any
        // left behind by a crash or forced shutdown.
        let cache_dir = data_dir.join("cache");
        let _ = fs::create_dir_all(&cache_dir);
        if let Ok(entries) = fs::read_dir(&cache_dir) {
            let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(24 * 3600);
            for entry in entries.flatten() {
                let stale = entry.metadata().ok()
                    .and_then(|m| m.modified().ok())
                    .map(|m| m < cutoff)
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }

        let state_file = data_dir.join("teledrive.json");
        let now = Utc::now().timestamp_millis();

        let mut recovered = false;
        // If the main state file is missing or unreadable, fall back to the
        // .bak copy, then the recovery file, before starting fresh.
        let state_source = {
            let bak = data_dir.join("teledrive.json.bak");
            let rec = data_dir.join("teledrive.recovery.json");
            let main_ok = state_file.exists() && fs::read_to_string(&state_file)
                .map(|c| serde_json::from_str::<DatabaseState>(&c).is_ok()).unwrap_or(false);
            if !main_ok && bak.exists() && fs::read_to_string(&bak).map(|c| serde_json::from_str::<DatabaseState>(&c).is_ok()).unwrap_or(false) {
                let _ = fs::copy(&bak, &state_file);
                eprintln!("[TeleDrive] Restored database from teledrive.json.bak");
                bak
            } else if !main_ok && rec.exists() && fs::read_to_string(&rec).map(|c| serde_json::from_str::<DatabaseState>(&c).is_ok()).unwrap_or(false) {
                let _ = fs::copy(&rec, &state_file);
                eprintln!("[TeleDrive] Restored database from teledrive.recovery.json");
                rec
            } else {
                state_file.clone()
            }
        };
        let mut state = if state_source.exists() {
            match fs::read_to_string(&state_source) {
                Ok(content) => match serde_json::from_str::<DatabaseState>(&content) {
                    Ok(state) => state,
                    Err(err) => {
                        // Never silently destroy a state file from an older or
                        // newer build: keep a timestamped copy before starting
                        // fresh, and surface the reason in the log.
                        eprintln!("[TeleDrive] Cannot read database: {}. Keeping a copy and starting fresh.", err);
                        let backup = data_dir.join(format!(
                            "teledrive.unreadable-{}.json",
                            Utc::now().format("%Y%m%d-%H%M%S")
                        ));
                        let _ = fs::copy(&state_file, &backup);
                        recovered = true;
                        Self::default_state()
                    }
                },
                Err(err) => {
                    eprintln!("[TeleDrive] Cannot open database: {}", err);
                    recovered = true;
                    Self::default_state()
                }
            }
        } else {
            let initial = Self::default_state();
            if let Ok(serialized) = serde_json::to_string_pretty(&initial) {
                let _ = fs::write(&state_file, serialized);
            }
            initial
        };

        if state.storage_mode != "telegram" {
            state.storage_mode = default_storage_mode();
            recovered = true;
        }
        if state.local_mirror_enabled || state.local_mirror_path.is_some() {
            state.local_mirror_enabled = false;
            state.local_mirror_path = None;
            recovered = true;
        }

        // Recover records that earlier builds left behind. The native app used
        // to share this data directory with the WinUI build (which kept its own
        // teledrive-db.json), and a few native releases could persist Telegram
        // parts without the matching file record. Import those records before
        // the UI is shown so a completed upload is never invisible.
        let imported_legacy = crate::recovery::import_legacy_winui_state(&mut state, &data_dir);
        let imported_backup = crate::recovery::import_missing_from_backup(
            &mut state,
            &data_dir.join("teledrive.json.bak"),
        );
        if imported_legacy + imported_backup > 0 {
            eprintln!(
                "[TeleDrive] Recovered {} file record(s) from previous local databases.",
                imported_legacy + imported_backup
            );
            recovered = true;
        }

        // A file whose folder no longer exists is unreachable in every view;
        // move it back to the drive root instead of hiding it forever.
        let folder_ids: std::collections::HashSet<String> =
            state.folders.iter().map(|f| f.id.clone()).collect();
        for file in &mut state.files {
            if let Some(folder_id) = file.folder_id.as_deref() {
                if !folder_ids.contains(folder_id) {
                    file.folder_id = None;
                    recovered = true;
                }
            }
        }

        // Backfill / update file categories so videos, photos, and music appear correctly
        for file in &mut state.files {
            if file.category == "document" || file.category.is_empty() {
                let detected = crate::models::detect_category(&file.mime_type, &file.extension);
                if detected != "document" {
                    file.category = detected.to_string();
                }
            }
        }

        // Always ensure bots from environment / .env are present and up to date
        if let Some(tokens_str) = crate::config::get_var("TELEGRAM_BOT_TOKENS") {
            let env_tokens: Vec<&str> = tokens_str.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            if state.bots.is_empty() || state.bots.iter().all(|b| b.token.is_empty()) || state.bots.len() < env_tokens.len() {
                state.bots.clear();
                for token in env_tokens {
                    let bot_id = token.split(':').next().unwrap_or("bot").to_string();
                    state.bots.push(BotRecord {
                        id: bot_id.clone(),
                        username: format!("@uploadertele_bot"),
                        token: token.to_string(),
                        healthy: true,
                        in_flight: 0,
                        parts_uploaded: 0,
                        bytes_uploaded: 0,
                        last_error: None,
                    });
                }
            }
        }

        // One-time: earlier builds defaulted to the on-disk vault, so existing
        // installs are still "local". Move them to Telegram storage when bots
        // are configured. Files already in the vault stay readable (their
        // "local:" ids resolve regardless of mode); only new uploads change.
        if !state.storage_migrated {
            if state.bots.iter().any(|b| !b.token.is_empty()) {
                state.storage_mode = "telegram".to_string();
            }
            state.storage_migrated = true;
            recovered = true; // forces a save below
        }

        if recovered {
            if let Ok(serialized) = serde_json::to_string_pretty(&state) {
                let _ = fs::write(&state_file, serialized);
            }
        }

        Database {
            data_dir,
            thumbnails_dir,
            cache_dir,
            vault_dir,
            vault_files_dir,
            backups_dir,
            state_file,
            state: Arc::new(RwLock::new(state)),
            start_time: now / 1000,
        }
    }

    fn default_state() -> DatabaseState {
        // A fresh install starts empty. Demo/Telegram seed data would point at
        // documents that do not exist in the local vault.
        let files: Vec<FileRecord> = Vec::new();
        let folders: Vec<FolderRecord> = Vec::new();
        let blobs: Vec<BlobRecord> = Vec::new();
        let parts: Vec<PartRecord> = Vec::new();

        let mut bots: Vec<BotRecord> = Vec::new();
        if let Some(tokens_str) = crate::config::get_var("TELEGRAM_BOT_TOKENS") {
            for token in tokens_str.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                let bot_id = token.split(':').next().unwrap_or("bot").to_string();
                bots.push(BotRecord {
                    id: bot_id.clone(),
                    username: format!("@uploadertele_bot"),
                    token: token.to_string(),
                    healthy: true,
                    in_flight: 0,
                    parts_uploaded: 0,
                    bytes_uploaded: 0,
                    last_error: None,
                });
            }
        }

        let admin_pw = crate::config::get_var("ADMIN_PASSWORD");

        DatabaseState {
            files,
            folders,
            blobs,
            parts,
            bots,
            storage_mode: default_storage_mode(),
            storage_migrated: true,
            part_size_mb: default_part_size_mb(),
            slice_size_mb: default_slice_size_mb(),
            client_upload_concurrency: default_client_upload_concurrency(),
            telegram_upload_concurrency: default_telegram_upload_concurrency(),
            bot_max_concurrent_uploads: default_bot_max_concurrent_uploads(),
            admin_password: admin_pw,
            local_mirror_path: default_local_mirror_path(),
            local_mirror_enabled: default_local_mirror_enabled(),
            download_dir: None,
            download_concurrency: default_download_concurrency(),
            cache_limit_gb: default_cache_limit_gb(),
            recovery_scanned_blobs: Vec::new(),
        }
    }

    pub fn save(&self) {
        if let Ok(state) = self.state.read() {
            let Ok(json) = serde_json::to_string_pretty(&*state) else { return; };
            // Write to a unique temp file and rename it into place so a crash
            // mid-write cannot leave a truncated state file behind. Unique
            // names also keep concurrent saves from clobbering each other.
            let tmp = self.state_file.with_file_name(format!(".teledrive-{}.tmp", Uuid::new_v4()));
            let written = fs::File::create(&tmp).and_then(|mut file| {
                use std::io::Write;
                file.write_all(json.as_bytes())?;
                file.sync_all()
            });
            if written.is_err() {
                let _ = fs::remove_file(&tmp);
                return;
            }
            // Keep the last good copy before replacing — a rename racing a
            // crash must never leave zero usable copies.
            if self.state_file.exists() {
                let bak = self.state_file.with_file_name("teledrive.json.bak");
                if fs::read_to_string(&self.state_file).map(|c| {
                    !c.trim().is_empty() && serde_json::from_str::<serde_json::Value>(&c).is_ok()
                }).unwrap_or(false) {
                    let _ = fs::copy(&self.state_file, &bak);
                }
            }
            let delays = [10u64, 20, 40, 80, 100];
            let mut renamed = false;
            for (i, ms) in delays.iter().enumerate() {
                match fs::rename(&tmp, &self.state_file) {
                    Ok(()) => { renamed = true; break; }
                    Err(_) if i + 1 < delays.len() => std::thread::sleep(std::time::Duration::from_millis(*ms)),
                    Err(_) => {}
                }
            }
            if !renamed {
                // Last resort: never lose the serialized state — park it next to
                // the state file for manual recovery.
                let recovery = self.state_file.with_file_name("teledrive.recovery.json");
                let _ = fs::write(&recovery, &json);
                eprintln!("[TeleDrive] ALERT: could not write {}; state saved to teledrive.recovery.json", self.state_file.display());
            }
            let _ = fs::remove_file(&tmp); // no-op when renamed; cleans up on total failure
        }
    }

    /// Resolve a local vault file id (`local:<negative message id>`) to disk.
    pub fn local_path_for_file_id(&self, file_id: &str) -> Option<PathBuf> {
        let raw = file_id.strip_prefix("local:")?;
        let id = raw.parse::<i64>().ok()?.unsigned_abs();
        Some(self.vault_files_dir.join(id.to_string()))
    }

    pub fn local_path_for_message_id(&self, message_id: i64) -> Option<PathBuf> {
        if message_id >= 0 {
            return None;
        }
        Some(self.vault_files_dir.join(message_id.unsigned_abs().to_string()))
    }

    /// (bytes, files) currently stored in the built-in vault.
    #[allow(dead_code)]
    pub fn vault_usage(&self) -> (u64, u64) {
        fn walk(dir: &Path, bytes: &mut u64, files: &mut u64) {
            let Ok(entries) = fs::read_dir(dir) else { return; };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, bytes, files);
                } else if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        *bytes += meta.len();
                        *files += 1;
                    }
                }
            }
        }
        let mut bytes = 0;
        let mut files = 0;
        walk(&self.vault_files_dir, &mut bytes, &mut files);
        (bytes, files)
    }

    /// (bytes, files) currently stored in cache and thumbnails.
    pub fn cache_usage(&self) -> (u64, u64) {
        fn walk(dir: &Path, bytes: &mut u64, files: &mut u64) {
            let Ok(entries) = fs::read_dir(dir) else { return; };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, bytes, files);
                } else if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        *bytes += meta.len();
                        *files += 1;
                    }
                }
            }
        }
        let mut bytes = 0;
        let mut files = 0;
        walk(&self.cache_dir, &mut bytes, &mut files);
        walk(&self.thumbnails_dir, &mut bytes, &mut files);
        (bytes, files)
    }

    /// Locate a cached visual thumbnail on disk (checking metadata mirror drive first, then local thumbnails cache).
    pub fn find_thumbnail_path(&self, file_id: &str) -> Option<PathBuf> {
        // 1. Check metadata mirror drive (if configured)
        let state = self.state.read_safe();
        if state.local_mirror_enabled {
            if let Some(ref mirror_root) = state.local_mirror_path {
                let mirror_dir = PathBuf::from(mirror_root).join("thumbnails");
                for ext in &["webp", "jpg", "jpeg", "png"] {
                    let p = mirror_dir.join(format!("{}.{}", file_id, ext));
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
        }
        // 2. Check local thumbnails_dir
        for ext in &["webp", "jpg", "jpeg", "png"] {
            let p = self.thumbnails_dir.join(format!("{}.{}", file_id, ext));
            if p.is_file() {
                return Some(p);
            }
        }
        None
    }

    /// Free and total bytes of the volume that holds the local vault.
    pub fn disk_space(&self) -> (u64, u64) {
        disk_space_for(&self.vault_dir)
    }

    /// Local vault part names currently referenced by the database.
    fn referenced_local_names(&self) -> std::collections::HashSet<String> {
        let state = self.state.read_safe();
        state.parts.iter()
            .filter_map(|p| p.telegram_file_id.strip_prefix("local:"))
            .filter_map(|raw| raw.parse::<i64>().ok())
            .map(|id| id.unsigned_abs().to_string())
            .collect()
    }

    /// Remove unreferenced vault part files and abandoned staging files.
    /// Only files older than `older_than_secs` are touched so an upload that
    /// is being finalized right now can never be deleted out from under it.
    /// `keep` lists locally staged parts that belong to resumable sessions but
    /// have not been finalized into the database yet.
    pub fn cleanup_orphan_vault_files(&self, older_than_secs: u64, keep: &std::collections::HashSet<String>) -> usize {
        let mut referenced = self.referenced_local_names();
        referenced.extend(keep.iter().cloned());
        let cutoff = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(older_than_secs));
        let Ok(entries) = fs::read_dir(&self.vault_files_dir) else { return 0; };
        let mut removed = 0usize;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue; };
            if !meta.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let staging = name.starts_with('.');
            let numeric_part = !name.is_empty() && name.chars().all(|c| c.is_ascii_digit());
            if !staging && !numeric_part {
                continue;
            }
            let stale = match (&cutoff, meta.modified().ok()) {
                (Some(cutoff), Some(modified)) => modified < *cutoff,
                _ => false,
            };
            if !stale {
                continue;
            }
            if (staging || !referenced.contains(&name)) && fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    /// Remove temporary downloads and generated ZIP archives that were left
    /// behind by an interrupted request. Only cache files older than the cutoff.
    pub fn cleanup_stale_cache_files(&self, older_than_secs: u64) -> usize {
        let cache_dir = self.data_dir.join("cache");
        let cutoff = std::time::SystemTime::now()
            .checked_sub(std::time::Duration::from_secs(older_than_secs));
        let Ok(entries) = fs::read_dir(&cache_dir) else { return 0; };
        let mut removed = 0usize;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let temporary = (name.starts_with("download-") && name.ends_with(".bin"))
                || (name.starts_with("zip-src-") && name.ends_with(".bin"))
                || (name.starts_with("zip-") && name.ends_with(".zip"));
            if !temporary {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue; };
            if !meta.is_file() {
                continue;
            }
            let stale = match (&cutoff, meta.modified().ok()) {
                (Some(cutoff), Some(modified)) => modified < *cutoff,
                _ => false,
            };
            if stale && fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }

    /// Deletion targets for trash roots older than the retention window.
    pub fn expired_trash_targets(&self, retention_days: i64) -> (Vec<String>, Vec<String>, Vec<PartDeletionTarget>) {
        let cutoff = Utc::now().timestamp_millis() - retention_days.max(0) * 24 * 60 * 60 * 1000;
        let (file_ids, folder_ids) = {
            let state = self.state.read_safe();
            let files: Vec<String> = state.files.iter()
                .filter(|f| f.trashed_at.map(|t| t < cutoff).unwrap_or(false))
                .map(|f| f.id.clone())
                .collect();
            let folders: Vec<String> = state.folders.iter()
                .filter(|f| f.trashed_at.map(|t| t < cutoff).unwrap_or(false))
                .map(|f| f.id.clone())
                .collect();
            (files, folders)
        };
        self.get_deletion_targets_for_items(&file_ids, &folder_ids)
    }

    /// Check every local vault part referenced by a file. This validates
    /// presence and size (fast) rather than re-hashing multi-gigabyte data.
    pub fn verify_vault(&self) -> serde_json::Value {
        let state = self.state.read_safe();
        let mut checked_files = 0usize;
        let mut checked_parts = 0usize;
        let mut remote_parts = 0usize;
        let mut total_local_bytes = 0u64;
        let mut missing_parts = 0usize;
        let mut size_mismatches = 0usize;
        let mut issues: Vec<serde_json::Value> = Vec::new();
        let mut referenced: std::collections::HashSet<String> = std::collections::HashSet::new();

        let mut parts_by_blob: std::collections::HashMap<&str, Vec<&PartRecord>> =
            std::collections::HashMap::new();
        for part in &state.parts {
            parts_by_blob.entry(part.blob_id.as_str()).or_default().push(part);
        }

        for file in &state.files {
            let Some(parts) = parts_by_blob.get(file.blob_id.as_str()) else {
                continue;
            };
            if parts.is_empty() {
                continue;
            }
            checked_files += 1;
            for part in parts {
                let Some(raw) = part.telegram_file_id.strip_prefix("local:") else {
                    remote_parts += 1;
                    continue;
                };
                if let Ok(id) = raw.parse::<i64>() {
                    referenced.insert(id.unsigned_abs().to_string());
                }
                checked_parts += 1;
                total_local_bytes = total_local_bytes.saturating_add(part.size);
                let path = self.local_path_for_file_id(&part.telegram_file_id);
                let problem = match path {
                    None => Some(("invalid", 0u64)),
                    Some(path) => match fs::metadata(&path) {
                        Ok(meta) if meta.len() == part.size => None,
                        Ok(meta) => Some(("size", meta.len())),
                        Err(_) => Some(("missing", 0u64)),
                    },
                };
                if let Some((kind, actual)) = problem {
                    if kind == "missing" {
                        missing_parts += 1;
                    } else {
                        size_mismatches += 1;
                    }
                    if issues.len() < 100 {
                        issues.push(serde_json::json!({
                            "fileId": file.id,
                            "name": file.name,
                            "partIndex": part.part_index,
                            "problem": kind,
                            "expected": part.size,
                            "actual": actual
                        }));
                    }
                }
            }
        }

        let mut orphan_files = 0usize;
        let mut orphan_bytes = 0u64;
        if let Ok(entries) = fs::read_dir(&self.vault_files_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.is_empty() || !name.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                if referenced.contains(&name) {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        orphan_files += 1;
                        orphan_bytes = orphan_bytes.saturating_add(meta.len());
                    }
                }
            }
        }

        serde_json::json!({
            "ok": missing_parts == 0 && size_mismatches == 0,
            "checkedAt": Utc::now().timestamp_millis(),
            "checkedFiles": checked_files,
            "checkedParts": checked_parts,
            "remoteParts": remote_parts,
            "missingParts": missing_parts,
            "sizeMismatches": size_mismatches,
            "orphanFiles": orphan_files,
            "orphanBytes": orphan_bytes,
            "totalLocalBytes": total_local_bytes,
            "issues": issues
        })
    }

    fn backup_meta(path: &Path, created_at: i64) -> Option<serde_json::Value> {
        let meta = fs::metadata(path).ok()?;
        if !meta.is_file() {
            return None;
        }
        let name = path.file_name()?.to_string_lossy().to_string();
        Some(serde_json::json!({
            "id": name,
            "messageId": serde_json::Value::Null,
            "botId": serde_json::Value::Null,
            "fileName": name,
            "size": meta.len(),
            "createdAt": created_at
        }))
    }

    /// Snapshot the database into the local backups folder. Snapshots contain
    /// file/folder/part records and settings, not document bytes; the vault
    /// folder can be copied separately for a full manual backup.
    pub fn create_backup(&self) -> Result<(serde_json::Value, PathBuf), String> {
        let state = self.state.read_safe();
        let mut value = serde_json::to_value(&*state).map_err(|e| e.to_string())?;
        drop(state);
        // Snapshots are downloadable, so never write bot tokens into them.
        // The live teledrive.json keeps the tokens; re-add bots after a restore.
        if let Some(bots) = value.get_mut("bots").and_then(|v| v.as_array_mut()) {
            for bot in bots {
                if let Some(obj) = bot.as_object_mut() {
                    obj.insert("token".to_string(), serde_json::Value::String(String::new()));
                }
            }
        }
        let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;

        fs::create_dir_all(&self.backups_dir).map_err(|e| e.to_string())?;
        let now = Utc::now();
        let name = format!("teledrive-backup-{}.json", now.format("%Y%m%d-%H%M%S-%3f"));
        let path = self.backups_dir.join(&name);
        let tmp = self.backups_dir.join(format!(".{}.tmp", name));
        fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
        if fs::rename(&tmp, &path).is_err() {
            let _ = fs::remove_file(&tmp);
            return Err("could not commit backup file".to_string());
        }
        let meta = Self::backup_meta(&path, now.timestamp_millis())
            .ok_or_else(|| "could not read backup metadata".to_string())?;

        // Keep the newest ten snapshots so repeated clicks cannot grow forever.
        let mut entries: Vec<(PathBuf, i64)> = fs::read_dir(&self.backups_dir)
            .map(|dir| dir.flatten().filter_map(|entry| {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    return None;
                }
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                let created = meta.modified().ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                Some((path, created))
            }).collect())
            .unwrap_or_default();
        entries.sort_by_key(|(_, created)| -created);
        for (path, _) in entries.into_iter().skip(10) {
            let _ = fs::remove_file(path);
        }

        Ok((meta, path))
    }

    pub fn list_backups(&self) -> Vec<serde_json::Value> {
        let Ok(entries) = fs::read_dir(&self.backups_dir) else { return Vec::new(); };
        let mut items: Vec<(i64, serde_json::Value)> = entries.flatten().filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let created = meta.modified().ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Self::backup_meta(&path, created).map(|value| (created, value))
        }).collect();
        items.sort_by_key(|(created, _)| -*created);
        items.into_iter().map(|(_, value)| value).collect()
    }

    pub fn latest_backup(&self) -> Option<serde_json::Value> {
        self.list_backups().into_iter().next()
    }

    /// A real Telegram token if one is configured. Used by delete flows that
    /// may mix local and Telegram parts even while the app is in local mode.
    pub fn any_bot_token(&self) -> Option<String> {
        let state = self.state.read_safe();
        state.bots.iter()
            .find(|b| !b.token.is_empty())
            .map(|b| b.token.clone())
    }

    pub fn to_file_dto(record: &FileRecord, part_count: usize) -> FileDTO {
        let meta: Option<serde_json::Value> = record.metadata.as_ref().and_then(|s| serde_json::from_str(s).ok());
        let tags: Vec<String> = record.tags
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let has_thumb = record.has_thumbnail != 0 || record.category == "image";
        FileDTO {
            id: record.id.clone(),
            folder_id: record.folder_id.clone(),
            name: record.name.clone(),
            extension: record.extension.clone(),
            mime_type: record.mime_type.clone(),
            category: record.category.clone(),
            size: record.size,
            status: record.status.clone(),
            description: record.description.clone(),
            tags,
            starred: record.starred != 0,
            has_thumbnail: has_thumb,
            thumbnail_url: if has_thumb {
                Some(format!("/api/thumbnails/{}", record.id))
            } else {
                None
            },
            width: record.width,
            height: record.height,
            duration: record.duration,
            metadata: meta,
            taken_at: record.taken_at,
            part_count,
            created_at: record.created_at,
            updated_at: record.updated_at,
            last_accessed_at: record.last_accessed_at,
            trashed_at: record.trashed_at,
        }
    }

    pub fn to_folder_dto(record: &FolderRecord, child_count: usize) -> FolderDTO {
        FolderDTO {
            id: record.id.clone(),
            parent_id: record.parent_id.clone(),
            name: record.name.clone(),
            color: record.color.clone(),
            starred: record.starred != 0,
            created_at: record.created_at,
            updated_at: record.updated_at,
            trashed_at: record.trashed_at,
            child_count,
        }
    }

    pub fn get_drive_contents(&self, folder_id: Option<&str>) -> DriveResponse {
        let state = self.state.read_safe();
        let target_id = folder_id.filter(|s| !s.is_empty() && *s != "root");

        let current_folder = target_id.and_then(|fid| {
            state.folders.iter().find(|f| f.id == fid && f.trashed_at.is_none()).map(|f| {
                let cnt = state.files.iter().filter(|x| x.folder_id.as_deref() == Some(&f.id) && x.trashed_at.is_none()).count()
                    + state.folders.iter().filter(|x| x.parent_id.as_deref() == Some(&f.id) && x.trashed_at.is_none()).count();
                Self::to_folder_dto(f, cnt)
            })
        });

        let mut breadcrumbs = Vec::new();
        if let Some(fid) = target_id {
            let mut curr = Some(fid.to_string());
            let mut chain = Vec::new();
            while let Some(cid) = curr {
                if let Some(f) = state.folders.iter().find(|f| f.id == cid) {
                    chain.push(Breadcrumb { id: f.id.clone(), name: f.name.clone() });
                    curr = f.parent_id.clone();
                } else {
                    break;
                }
            }
            chain.reverse();
            breadcrumbs.extend(chain);
        }

        let folders: Vec<FolderDTO> = state.folders
            .iter()
            .filter(|f| f.trashed_at.is_none() && f.parent_id.as_deref() == target_id)
            .map(|f| {
                let cnt = state.files.iter().filter(|x| x.folder_id.as_deref() == Some(&f.id) && x.trashed_at.is_none()).count();
                Self::to_folder_dto(f, cnt)
            })
            .collect();

        let files: Vec<FileDTO> = state.files
            .iter()
            .filter(|f| f.trashed_at.is_none() && f.folder_id.as_deref() == target_id)
            .map(|f| {
                let part_cnt = state.parts.iter().filter(|p| p.blob_id == f.blob_id).count();
                Self::to_file_dto(f, part_cnt)
            })
            .collect();

        let total_files = files.len();

        DriveResponse {
            folder: current_folder,
            breadcrumbs,
            folders,
            files,
            total_files,
        }
    }

    pub fn get_file(&self, id: &str) -> Option<(FileDTO, Vec<Breadcrumb>)> {
        let state = self.state.read_safe();
        let file = state.files.iter().find(|f| f.id == id)?;
        let part_cnt = state.parts.iter().filter(|p| p.blob_id == file.blob_id).count();
        let dto = Self::to_file_dto(file, part_cnt);

        let mut breadcrumbs = Vec::new();
        if let Some(ref fid) = file.folder_id {
            let mut curr = Some(fid.clone());
            let mut chain = Vec::new();
            while let Some(cid) = curr {
                if let Some(f) = state.folders.iter().find(|f| f.id == cid) {
                    chain.push(Breadcrumb { id: f.id.clone(), name: f.name.clone() });
                    curr = f.parent_id.clone();
                } else {
                    break;
                }
            }
            chain.reverse();
            breadcrumbs.extend(chain);
        }

        Some((dto, breadcrumbs))
    }

    pub fn get_starred(&self) -> (Vec<FileDTO>, Vec<FolderDTO>) {
        let state = self.state.read_safe();
        let files = state.files
            .iter()
            .filter(|f| f.trashed_at.is_none() && f.starred != 0)
            .map(|f| {
                let part_cnt = state.parts.iter().filter(|p| p.blob_id == f.blob_id).count();
                Self::to_file_dto(f, part_cnt)
            })
            .collect();

        let folders = state.folders
            .iter()
            .filter(|f| f.trashed_at.is_none() && f.starred != 0)
            .map(|f| {
                let cnt = state.files.iter().filter(|x| x.folder_id.as_deref() == Some(&f.id) && x.trashed_at.is_none()).count();
                Self::to_folder_dto(f, cnt)
            })
            .collect();

        (files, folders)
    }

    pub fn get_recent(&self, limit: usize) -> Vec<FileDTO> {
        let state = self.state.read_safe();
        let mut list: Vec<&FileRecord> = state.files
            .iter()
            .filter(|f| f.trashed_at.is_none())
            .collect();

        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        list.into_iter()
            .take(limit)
            .map(|f| {
                let part_cnt = state.parts.iter().filter(|p| p.blob_id == f.blob_id).count();
                Self::to_file_dto(f, part_cnt)
            })
            .collect()
    }

    pub fn get_trash(&self) -> (Vec<FileDTO>, Vec<FolderDTO>, u64) {
        let state = self.state.read_safe();
        let files: Vec<FileDTO> = state.files
            .iter()
            .filter(|f| f.trashed_at.is_some())
            .map(|f| {
                let part_cnt = state.parts.iter().filter(|p| p.blob_id == f.blob_id).count();
                Self::to_file_dto(f, part_cnt)
            })
            .collect();

        let folders: Vec<FolderDTO> = state.folders
            .iter()
            .filter(|f| f.trashed_at.is_some())
            .map(|f| {
                let cnt = state.files.iter().filter(|x| x.folder_id.as_deref() == Some(&f.id)).count();
                Self::to_folder_dto(f, cnt)
            })
            .collect();

        let total_size: u64 = files.iter().map(|f| f.size).sum();
        (files, folders, total_size)
    }

    pub fn search(&self, filter: &SearchFilter) -> (Vec<FileDTO>, Vec<FolderDTO>, usize) {
        let q = filter.q.trim().to_lowercase();
        let tokens: Vec<&str> = q.split_whitespace().collect();
        let state = self.state.read_safe();

        // Resolve complete subtree folder IDs if filtering by folder
        let subtree_ids: Option<std::collections::HashSet<String>> = filter.folder_id.as_ref().map(|root| {
            let mut set = std::collections::HashSet::new();
            set.insert(root.clone());
            let mut queue = vec![root.clone()];
            while let Some(cur) = queue.pop() {
                for folder in &state.folders {
                    if folder.trashed_at.is_none() && folder.parent_id.as_deref() == Some(&cur) {
                        if set.insert(folder.id.clone()) {
                            queue.push(folder.id.clone());
                        }
                    }
                }
            }
            set
        });

        let mut scored_files: Vec<(FileDTO, i32)> = Vec::new();
        for f in state.files.iter().filter(|f| f.trashed_at.is_none()) {
            if let Some(ref cat) = filter.category {
                if !cat.is_empty() && f.category != *cat { continue; }
            }
            if let Some(min) = filter.min_size {
                if f.size < min { continue; }
            }
            if let Some(max) = filter.max_size {
                if f.size > max { continue; }
            }
            if let Some(from) = filter.from {
                if f.created_at < from { continue; }
            }
            if let Some(to) = filter.to {
                if f.created_at > to { continue; }
            }
            if let Some(starred) = filter.starred {
                if (f.starred != 0) != starred { continue; }
            }
            if let Some(ref s_ids) = subtree_ids {
                let in_tree = f.folder_id.as_ref().map_or(false, |fid| s_ids.contains(fid));
                if !in_tree { continue; }
            }

            let name_lower = f.name.to_lowercase();
            let ext_lower = f.extension.to_lowercase();
            let tags_lower = f.tags.to_lowercase();
            let desc_lower = f.description.to_lowercase();

            let mut matches_all = true;
            let mut score = 0;

            if !tokens.is_empty() {
                for token in &tokens {
                    let in_name = name_lower.contains(token);
                    let in_ext = ext_lower == *token;
                    let in_tags = tags_lower.contains(token);
                    let in_desc = desc_lower.contains(token);

                    if !in_name && !in_ext && !in_tags && !in_desc {
                        matches_all = false;
                        break;
                    }

                    if name_lower == *token {
                        score += 100;
                    } else if name_lower.starts_with(token) {
                        score += 70;
                    } else if in_name {
                        score += 40;
                    }
                    if in_ext { score += 30; }
                    if in_tags { score += 20; }
                    if in_desc { score += 10; }
                }
            } else {
                score = 1;
            }

            if matches_all {
                let part_cnt = state.parts.iter().filter(|p| p.blob_id == f.blob_id).count();
                scored_files.push((Self::to_file_dto(f, part_cnt), score));
            }
        }

        scored_files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.created_at.cmp(&a.0.created_at)));
        let files: Vec<FileDTO> = scored_files.into_iter().map(|(f, _)| f).collect();

        let mut scored_folders: Vec<(FolderDTO, i32)> = Vec::new();
        for f in state.folders.iter().filter(|f| f.trashed_at.is_none()) {
            if filter.category.as_ref().map_or(false, |c| !c.is_empty() && c != "folders") {
                continue;
            }
            if let Some(ref s_ids) = subtree_ids {
                // If searching in a folder, only include descendant subfolders
                if !s_ids.contains(&f.id) || filter.folder_id.as_deref() == Some(&f.id) {
                    continue;
                }
            }
            let name_lower = f.name.to_lowercase();
            let mut matches_all = true;
            let mut score = 0;
            if !tokens.is_empty() {
                for token in &tokens {
                    if !name_lower.contains(token) {
                        matches_all = false;
                        break;
                    }
                    if name_lower == *token {
                        score += 100;
                    } else if name_lower.starts_with(token) {
                        score += 70;
                    } else {
                        score += 40;
                    }
                }
            } else {
                score = 1;
            }

            if matches_all {
                let cnt = state.files.iter().filter(|x| x.folder_id.as_deref() == Some(&f.id)).count();
                scored_folders.push((Self::to_folder_dto(f, cnt), score));
            }
        }

        scored_folders.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.name.to_lowercase().cmp(&b.0.name.to_lowercase())));
        let folders: Vec<FolderDTO> = scored_folders.into_iter().map(|(f, _)| f).collect();
        let total = files.len() + folders.len();

        (files, folders, total)
    }

    pub fn suggest(&self, q: &str) -> Vec<String> {
        let query = q.trim().to_lowercase();
        if query.is_empty() { return Vec::new(); }
        let state = self.state.read_safe();
        let mut out: Vec<String> = Vec::new();

        // 1. Prefix match file names
        for f in state.files.iter().filter(|f| f.trashed_at.is_none()) {
            if f.name.to_lowercase().starts_with(&query) && !out.contains(&f.name) {
                out.push(f.name.clone());
                if out.len() >= 6 { return out; }
            }
        }
        // 2. Prefix match folder names
        for f in state.folders.iter().filter(|f| f.trashed_at.is_none()) {
            if f.name.to_lowercase().starts_with(&query) && !out.contains(&f.name) {
                out.push(f.name.clone());
                if out.len() >= 6 { return out; }
            }
        }
        // 3. Substring match
        for f in state.files.iter().filter(|f| f.trashed_at.is_none()) {
            if f.name.to_lowercase().contains(&query) && !out.contains(&f.name) {
                out.push(f.name.clone());
                if out.len() >= 6 { return out; }
            }
        }
        out
    }

    pub fn create_folder(&self, name: &str, parent_id: Option<String>) -> FolderDTO {
        let now = Utc::now().timestamp_millis();
        let record = FolderRecord {
            id: Uuid::new_v4().to_string(),
            parent_id,
            name: name.to_string(),
            color: None,
            starred: 0,
            trashed_at: None,
            trash_root: 0,
            created_at: now,
            updated_at: now,
        };

        {
            let mut state = self.state.write_safe();
            state.folders.push(record.clone());
        }
        self.save();
        Self::to_folder_dto(&record, 0)
    }

    pub fn update_folder(&self, id: &str, name: Option<&str>, color: Option<&str>) -> bool {
        let now = Utc::now().timestamp_millis();
        let mut found = false;
        {
            let mut state = self.state.write_safe();
            if let Some(f) = state.folders.iter_mut().find(|x| x.id == id) {
                if let Some(n) = name { f.name = n.to_string(); }
                if let Some(c) = color { f.color = Some(c.to_string()); }
                f.updated_at = now;
                found = true;
            }
        }
        if found { self.save(); }
        found
    }

    pub fn update_file(&self, id: &str, name: Option<&str>, starred: Option<bool>, folder_id: Option<Option<String>>) -> bool {
        let now = Utc::now().timestamp_millis();
        let mut found = false;
        {
            let mut state = self.state.write_safe();
            if let Some(f) = state.files.iter_mut().find(|x| x.id == id) {
                if let Some(n) = name {
                    f.name = n.to_string();
                    if let Some(ext) = Path::new(n).extension().and_then(|s| s.to_str()) {
                        f.extension = ext.to_lowercase();
                    }
                }
                if let Some(st) = starred {
                    f.starred = if st { 1 } else { 0 };
                }
                if let Some(fid) = folder_id {
                    f.folder_id = fid;
                }
                f.updated_at = now;
                found = true;
            }
        }
        if found { self.save(); }
        found
    }

    pub fn set_star_items(&self, file_ids: &[String], folder_ids: &[String], starred: bool) {
        let val = if starred { 1 } else { 0 };
        {
            let mut state = self.state.write_safe();
            for fid in file_ids {
                if let Some(f) = state.files.iter_mut().find(|x| x.id == *fid) {
                    f.starred = val;
                }
            }
            for fid in folder_ids {
                if let Some(f) = state.folders.iter_mut().find(|x| x.id == *fid) {
                    f.starred = val;
                }
            }
        }
        self.save();
    }

    pub fn trash_items(&self, file_ids: &[String], folder_ids: &[String]) {
        let now = Utc::now().timestamp_millis();
        {
            let mut state = self.state.write_safe();
            for fid in file_ids {
                if let Some(f) = state.files.iter_mut().find(|x| x.id == *fid) {
                    f.trashed_at = Some(now);
                    f.trash_root = 1;
                }
            }
            for fid in folder_ids {
                if let Some(f) = state.folders.iter_mut().find(|x| x.id == *fid) {
                    f.trashed_at = Some(now);
                    f.trash_root = 1;
                }
            }
        }
        self.save();
    }

    pub fn restore_items(&self, file_ids: &[String], folder_ids: &[String]) {
        {
            let mut state = self.state.write_safe();
            for fid in file_ids {
                if let Some(f) = state.files.iter_mut().find(|x| x.id == *fid) {
                    f.trashed_at = None;
                    f.trash_root = 0;
                }
            }
            for fid in folder_ids {
                if let Some(f) = state.folders.iter_mut().find(|x| x.id == *fid) {
                    f.trashed_at = None;
                    f.trash_root = 0;
                }
            }
        }
        self.save();
    }

    pub fn get_deletion_targets_for_items(&self, file_ids: &[String], folder_ids: &[String]) -> (Vec<String>, Vec<String>, Vec<PartDeletionTarget>) {
        let state = self.state.read_safe();
        
        let mut all_folder_ids = folder_ids.to_vec();
        let mut idx = 0;
        while idx < all_folder_ids.len() {
            let cur_id = all_folder_ids[idx].clone();
            for f in &state.folders {
                if f.parent_id.as_deref() == Some(&cur_id) && !all_folder_ids.contains(&f.id) {
                    all_folder_ids.push(f.id.clone());
                }
            }
            idx += 1;
        }

        let mut all_file_ids = file_ids.to_vec();
        for f in &state.files {
            if let Some(ref fid) = f.folder_id {
                if all_folder_ids.contains(fid) && !all_file_ids.contains(&f.id) {
                    all_file_ids.push(f.id.clone());
                }
            }
        }

        let target_blobs: Vec<String> = state.files.iter()
            .filter(|f| all_file_ids.contains(&f.id))
            .map(|f| f.blob_id.clone())
            .collect();

        // Keep parts that are still referenced by a file outside this deletion
        // (for example the original of a copied file, which shares its blob).
        let retained_blobs: std::collections::HashSet<String> = state.files.iter()
            .filter(|f| !all_file_ids.contains(&f.id))
            .map(|f| f.blob_id.clone())
            .collect();

        let part_targets: Vec<PartDeletionTarget> = state.parts.iter()
            .filter(|p| target_blobs.contains(&p.blob_id)
                && !retained_blobs.contains(&p.blob_id)
                && p.telegram_message_id != 0)
            .map(|p| PartDeletionTarget {
                bot_id: p.bot_id.clone(),
                channel_id: p.telegram_channel_id.clone(),
                message_id: p.telegram_message_id,
            })
            .collect();

        (all_file_ids, all_folder_ids, part_targets)
    }

    pub fn get_deletion_targets_for_trash(&self) -> (Vec<String>, Vec<String>, Vec<PartDeletionTarget>) {
        let state = self.state.read_safe();
        let file_ids: Vec<String> = state.files.iter()
            .filter(|f| f.trashed_at.is_some())
            .map(|f| f.id.clone())
            .collect();
        let folder_ids: Vec<String> = state.folders.iter()
            .filter(|f| f.trashed_at.is_some())
            .map(|f| f.id.clone())
            .collect();
        drop(state);
        self.get_deletion_targets_for_items(&file_ids, &folder_ids)
    }

    pub fn purge_deleted_records(&self, file_ids: &[String], folder_ids: &[String]) {
        let mut state = self.state.write_safe();
        
        let target_blobs: Vec<String> = state.files.iter()
            .filter(|f| file_ids.contains(&f.id))
            .map(|f| f.blob_id.clone())
            .collect();

        state.files.retain(|f| !file_ids.contains(&f.id));
        state.folders.retain(|f| !folder_ids.contains(&f.id));
        // Copies share their blob/parts with the original. Only drop storage
        // records that are no longer referenced by any remaining file.
        let still_referenced: std::collections::HashSet<String> = state.files.iter()
            .map(|f| f.blob_id.clone())
            .collect();
        state.parts.retain(|p| !target_blobs.contains(&p.blob_id) || still_referenced.contains(&p.blob_id));
        state.blobs.retain(|b| !target_blobs.contains(&b.id) || still_referenced.contains(&b.id));

        drop(state);
        self.save();

        for fid in file_ids {
            let tpath = self.thumbnails_dir.join(format!("{}.jpg", fid));
            let _ = fs::remove_file(tpath);
        }
    }

    #[allow(dead_code)]
    pub fn delete_items(&self, file_ids: &[String], folder_ids: &[String]) {
        let (all_files, all_folders, _) = self.get_deletion_targets_for_items(file_ids, folder_ids);
        self.purge_deleted_records(&all_files, &all_folders);
    }

    #[allow(dead_code)]
    pub fn empty_trash(&self) {
        let (all_files, all_folders, _) = self.get_deletion_targets_for_trash();
        self.purge_deleted_records(&all_files, &all_folders);
    }

    pub fn move_items(&self, file_ids: &[String], folder_ids: &[String], target: Option<String>) {
        let now = Utc::now().timestamp_millis();
        {
            let mut state = self.state.write_safe();
            for fid in file_ids {
                if let Some(f) = state.files.iter_mut().find(|x| x.id == *fid) {
                    f.folder_id = target.clone();
                    f.updated_at = now;
                }
            }
            for fid in folder_ids {
                if let Some(f) = state.folders.iter_mut().find(|x| x.id == *fid) {
                    f.parent_id = target.clone();
                    f.updated_at = now;
                }
            }
        }
        self.save();
    }

    /// Flatten the selected files and folder trees into ZIP entry paths.
    /// `None` marks an explicit directory entry (for empty folders).
    pub fn zip_entries(&self, file_ids: &[String], folder_ids: &[String]) -> Vec<(String, Option<FileRecord>)> {
        let state = self.state.read_safe();
        let selected: std::collections::HashSet<String> = folder_ids.iter().cloned().collect();

        let mut roots: Vec<String> = Vec::new();
        for fid in folder_ids {
            let mut nested = false;
            let mut cur = fid.clone();
            let mut guard = 0usize;
            loop {
                let Some(folder) = state.folders.iter().find(|f| f.id == cur) else { break; };
                let Some(parent) = folder.parent_id.clone() else { break; };
                if selected.contains(&parent) {
                    nested = true;
                    break;
                }
                cur = parent;
                guard += 1;
                if guard > 4096 {
                    break;
                }
            }
            if !nested && state.folders.iter().any(|f| f.id == *fid && f.trashed_at.is_none()) {
                roots.push(fid.clone());
            }
        }

        let mut entries: Vec<(String, Option<FileRecord>)> = Vec::new();
        let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut included: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut queue: Vec<(String, String)> = Vec::new();
        for id in roots {
            let Some(folder) = state.folders.iter().find(|f| f.id == id && f.trashed_at.is_none()) else { continue; };
            let base = unique_zip_path(&mut used, &zip_safe_component(&folder.name));
            queue.push((id, base));
        }

        while let Some((folder_id, base)) = queue.pop() {
            entries.push((base.clone(), None));
            let child_folders: Vec<(String, String)> = state.folders.iter()
                .filter(|f| f.parent_id.as_deref() == Some(folder_id.as_str()) && f.trashed_at.is_none())
                .map(|f| (f.id.clone(), zip_safe_component(&f.name)))
                .collect();
            for (child_id, name) in child_folders {
                let path = unique_zip_path(&mut used, &format!("{}/{}", base, name));
                queue.push((child_id, path));
            }
            for file in state.files.iter()
                .filter(|f| f.folder_id.as_deref() == Some(folder_id.as_str()) && f.trashed_at.is_none())
            {
                let path = unique_zip_path(&mut used, &format!("{}/{}", base, zip_safe_component(&file.name)));
                included.insert(file.id.clone());
                entries.push((path, Some(file.clone())));
            }
        }

        for fid in file_ids {
            if included.contains(fid) {
                continue;
            }
            let Some(file) = state.files.iter().find(|f| f.id == *fid && f.trashed_at.is_none()) else { continue; };
            let path = unique_zip_path(&mut used, &zip_safe_component(&file.name));
            included.insert(file.id.clone());
            entries.push((path, Some(file.clone())));
        }

        entries
    }

    pub fn copy_items(&self, file_ids: &[String], folder_ids: &[String], target: Option<String>) {
        let now = Utc::now().timestamp_millis();
        {
            let mut state = self.state.write_safe();

            // A folder and one of its descendants can be selected together.
            // Copying the descendant twice would create duplicates, so only
            // selected folders that are not inside another selected folder
            // become copy roots.
            let selected: std::collections::HashSet<String> = folder_ids.iter().cloned().collect();
            let mut roots: Vec<String> = Vec::new();
            for fid in folder_ids {
                let mut nested = false;
                let mut cur = fid.clone();
                let mut guard = 0usize;
                loop {
                    let Some(folder) = state.folders.iter().find(|f| f.id == cur) else { break; };
                    let Some(parent) = folder.parent_id.clone() else { break; };
                    if selected.contains(&parent) {
                        nested = true;
                        break;
                    }
                    cur = parent;
                    guard += 1;
                    if guard > 4096 {
                        break;
                    }
                }
                let exists = state.folders.iter().any(|f| f.id == *fid && f.trashed_at.is_none());
                if !nested && exists {
                    roots.push(fid.clone());
                }
            }

            let mut new_folders: Vec<FolderRecord> = Vec::new();
            let mut new_files: Vec<FileRecord> = Vec::new();
            let mut cloned_files: std::collections::HashSet<String> = std::collections::HashSet::new();
            let mut queue: Vec<(String, Option<String>, bool)> = roots.into_iter()
                .map(|id| (id, target.clone(), true))
                .collect();

            while let Some((src_id, new_parent, is_root)) = queue.pop() {
                let Some(src) = state.folders.iter()
                    .find(|f| f.id == src_id && f.trashed_at.is_none())
                    .cloned() else { continue; };

                let mut clone = src.clone();
                clone.id = Uuid::new_v4().to_string();
                clone.parent_id = new_parent.clone();
                if is_root && src.parent_id == target {
                    clone.name = append_copy_suffix(&clone.name);
                }
                clone.created_at = now;
                clone.updated_at = now;
                let clone_id = clone.id.clone();

                let child_folders: Vec<String> = state.folders.iter()
                    .filter(|f| f.parent_id.as_deref() == Some(src_id.as_str()) && f.trashed_at.is_none())
                    .map(|f| f.id.clone())
                    .collect();
                let child_files: Vec<FileRecord> = state.files.iter()
                    .filter(|f| f.folder_id.as_deref() == Some(src_id.as_str()) && f.trashed_at.is_none())
                    .cloned()
                    .collect();

                new_folders.push(clone);
                for child_id in child_folders {
                    queue.push((child_id, Some(clone_id.clone()), false));
                }
                for mut file in child_files {
                    if !cloned_files.insert(file.id.clone()) {
                        continue;
                    }
                    file.id = Uuid::new_v4().to_string();
                    file.folder_id = Some(clone_id.clone());
                    file.created_at = now;
                    file.updated_at = now;
                    new_files.push(file);
                }
            }

            // Explicit file selections that were not already copied as part of
            // a selected folder tree.
            for fid in file_ids {
                if cloned_files.contains(fid) {
                    continue;
                }
                let Some(src) = state.files.iter()
                    .find(|f| f.id == *fid && f.trashed_at.is_none())
                    .cloned() else { continue; };
                let mut clone = src.clone();
                clone.id = Uuid::new_v4().to_string();
                clone.folder_id = target.clone();
                if src.folder_id == target {
                    clone.name = append_copy_suffix(&clone.name);
                }
                clone.created_at = now;
                clone.updated_at = now;
                new_files.push(clone);
            }

            state.folders.extend(new_folders);
            state.files.extend(new_files);
        }
        self.save();
    }

    /// Duplicate one file in place, sharing the original blob and parts.
    pub fn duplicate_file(&self, id: &str) -> Result<String, String> {
        let now = Utc::now().timestamp_millis();
        let new_id;
        {
            let mut state = self.state.write_safe();
            let src = state.files.iter()
                .find(|f| f.id == id && f.trashed_at.is_none())
                .cloned()
                .ok_or_else(|| "File not found".to_string())?;
            let mut clone = src.clone();
            clone.id = Uuid::new_v4().to_string();
            clone.name = append_copy_suffix(&clone.name);
            clone.created_at = now;
            clone.updated_at = now;
            new_id = clone.id.clone();
            state.files.push(clone);
        }
        self.save();
        Ok(new_id)
    }

    pub fn get_stats(&self) -> StatsResponse {
        let state = self.state.read_safe();
        let active_files: Vec<&FileRecord> = state.files.iter().filter(|f| f.trashed_at.is_none()).collect();
        let total_size: u64 = active_files.iter().map(|f| f.size).sum();
        let file_count = active_files.len();
        let folder_count = state.folders.iter().filter(|f| f.trashed_at.is_none()).count();

        let trash_files: Vec<&FileRecord> = state.files.iter().filter(|f| f.trashed_at.is_some()).collect();
        let trash_size: u64 = trash_files.iter().map(|f| f.size).sum();
        let trash_count = trash_files.len();

        let mut cats: std::collections::HashMap<String, (usize, u64)> = std::collections::HashMap::new();
        for f in &active_files {
            let entry = cats.entry(f.category.clone()).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += f.size;
        }

        let by_category = cats.into_iter().map(|(category, (count, size))| {
            StatsCategory { category, count, size }
        }).collect();

        let mut sorted = active_files.clone();
        sorted.sort_by(|a, b| b.size.cmp(&a.size));
        let largest_files = sorted.into_iter().take(5).map(|f| {
            let part_cnt = state.parts.iter().filter(|p| p.blob_id == f.blob_id).count();
            Self::to_file_dto(f, part_cnt)
        }).collect();

        let bots = state.bots.iter().map(|b| {
            StatsBot {
                bot_id: b.id.clone(),
                username: Some(b.username.clone()),
                healthy: b.healthy,
                parts_uploaded: b.parts_uploaded,
                bytes_uploaded: b.bytes_uploaded,
            }
        }).collect();

        StatsResponse {
            total_size,
            file_count,
            folder_count,
            trash_size,
            trash_count,
            by_category,
            uploads_by_day: Vec::new(),
            largest_files,
            bots,
        }
    }

    pub fn get_system_info(&self) -> SystemInfoResponse {
        let state = self.state.read_safe();
        let now = Utc::now().timestamp();
        let uptime_sec = (now - self.start_time).max(0) as u64;
        let (disk_free, disk_total) = disk_space_for(&self.data_dir);
        let (cache_bytes, cache_files) = self.cache_usage();

        let bots: Vec<SystemBot> = state.bots.iter().map(|b| {
            SystemBot {
                bot_id: b.id.clone(),
                username: Some(b.username.clone()),
                healthy: b.healthy,
                last_error: b.last_error.clone(),
                in_flight: b.in_flight,
            }
        }).collect();

        let channel_id_val = crate::config::get_var("TELEGRAM_CHANNEL_ID").unwrap_or_else(|| "-1004396487326".to_string());
        let channel_id = &channel_id_val;

        SystemInfoResponse {
            version: "3.1.7".to_string(),
            uptime_sec,
            bot_api: serde_json::json!({
                "url": "bundled://bot-api",
                "reachable": true,
                "latencyMs": 0
            }),
            channel: serde_json::json!({
                "id": channel_id,
                "title": "TeleDrive Cloud Storage"
            }),
            bots,
            disk: serde_json::json!({
                "dataDir": self.data_dir.to_string_lossy(),
                "used": cache_bytes,
                "free": disk_free,
                "total": disk_total
            }),
            cache: serde_json::json!({
                "usedBytes": cache_bytes,
                "maxBytes": 10 * 1024 * 1024 * 1024u64,
                "files": cache_files
            }),
            tools: serde_json::json!({
                "ffmpeg": false,
                "ffprobe": false,
                "pdftoppm": false
            }),
            queue: serde_json::json!({
                "receivedParts": 0,
                "uploadingParts": 0,
                "failedParts": 0,
                "pendingDeletions": 0
            }),
            last_backup: self.latest_backup(),
        }
    }

    /// Select the optimal bot with lowest active in_flight uploads for parallel concurrent distribution.
    pub fn acquire_optimal_bot(&self) -> Option<(String, String)> {
        let mut state = self.state.write_safe();
        let per_bot_limit = state.bot_max_concurrent_uploads.max(1) as i64;
        let mut candidates: Vec<(usize, i64)> = state.bots.iter().enumerate()
            .filter(|(_, b)| b.healthy && !b.token.is_empty() && b.in_flight < per_bot_limit)
            .map(|(i, b)| (i, b.in_flight))
            .collect();

        if candidates.is_empty() {
            return None;
        }

        // Sort by in_flight ascending (least loaded bot first)
        candidates.sort_by_key(|&(_, in_flight)| in_flight);
        let best_idx = candidates[0].0;
        state.bots[best_idx].in_flight += 1;
        Some((state.bots[best_idx].id.clone(), state.bots[best_idx].token.clone()))
    }

    /// Release a bot after upload attempt, updating stats and decrementing in-flight count.
    pub fn release_bot(&self, bot_id: &str, success: bool, bytes: u64, error_msg: Option<String>) {
        let mut state = self.state.write_safe();
        if let Some(bot) = state.bots.iter_mut().find(|b| b.id == bot_id) {
            bot.in_flight = (bot.in_flight - 1).max(0);
            if success {
                bot.parts_uploaded += 1;
                bot.bytes_uploaded += bytes;
                bot.last_error = None;
            } else if let Some(err) = error_msg {
                bot.last_error = Some(err);
            }
        }
    }

}
