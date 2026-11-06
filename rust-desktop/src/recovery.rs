//! One-time recovery helpers.
//!
//! TeleDrive stores documents in Telegram, so the local state file is the only
//! index that makes them visible. Earlier builds could lose that index (or keep
//! it in the WinUI database / a backup state file) while the Telegram messages
//! and parts were still present. This module rebuilds those file records.
//!
//! It also inspects orphaned Telegram-backed parts at startup. The public Bot
//! API has no history method, so recovery forwards one part to the storage
//! channel, reads the document name from the resulting message, and immediately
//! deletes the temporary forward. Only metadata is read; file bytes never touch
//! local storage.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use uuid::Uuid;

use crate::db::DatabaseState;
use crate::models::{detect_category, BlobRecord, FileRecord, PartRecord};
use crate::server::AppServer;
use crate::sync_ext::RwLockExt;

#[derive(Debug, Deserialize)]
struct LegacyPart {
    blob_id: String,
    idx: i64,
    size: u64,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    bot_id: String,
    #[serde(default)]
    message_id: i64,
    #[serde(default)]
    tg_file_id: String,
}

fn telegram_ref_is_usable(file_id: &str, message_id: i64) -> bool {
    message_id > 0
        && !file_id.trim().is_empty()
        && !file_id.starts_with("local:")
        // Older builds wrote a synthetic `part_<blob>_<idx>` identifier before
        // the Telegram response arrived. It cannot be downloaded.
        && !file_id.starts_with("part_")
}

fn parts_are_complete(parts: &[PartRecord], expected_size: u64) -> bool {
    if parts.is_empty() {
        return false;
    }
    let mut sorted = parts.to_vec();
    sorted.sort_by_key(|p| p.part_index);
    sorted
        .iter()
        .enumerate()
        .all(|(index, part)| part.part_index == index as i64)
        && sorted.iter().map(|p| p.size).sum::<u64>() == expected_size
}

fn content_sha(size: u64, parts: &[PartRecord]) -> String {
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, size.to_le_bytes());
    for part in parts {
        sha2::Digest::update(&mut hasher, part.sha256.as_bytes());
    }
    format!("{:x}", sha2::Digest::finalize(hasher))
}

fn extension_from_name(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
}

fn mime_from_name(name: &str) -> String {
    mime_guess::from_path(name)
        .first_or_octet_stream()
        .essence_str()
        .to_string()
}

fn normalize_imported_file(file: &mut FileRecord, folder_ids: &HashSet<String>) {
    if let Some(folder_id) = file.folder_id.as_deref() {
        if !folder_ids.contains(folder_id) {
            file.folder_id = None;
        }
    }
    if file.extension.is_empty() {
        file.extension = extension_from_name(&file.name);
    }
    if file.mime_type.is_empty() {
        file.mime_type = mime_from_name(&file.name);
    }
    if file.category.is_empty() || file.category == "document" {
        let detected = detect_category(&file.mime_type, &file.extension);
        if detected != "document" {
            file.category = detected.to_string();
        }
    }
}

fn import_one(
    state: &mut DatabaseState,
    mut file: FileRecord,
    parts: Vec<PartRecord>,
    blob: BlobRecord,
    folder_ids: &HashSet<String>,
    source: &str,
) -> bool {
    if file.trashed_at.is_some() || file.name.trim().is_empty() || file.size == 0 {
        return false;
    }
    if parts.iter().any(|part| !telegram_ref_is_usable(&part.telegram_file_id, part.telegram_message_id)) {
        return false;
    }
    if !parts_are_complete(&parts, file.size) {
        return false;
    }
    if state
        .files
        .iter()
        .any(|existing| {
            existing.blob_id == file.blob_id
                || (existing.name.eq_ignore_ascii_case(&file.name) && existing.size == file.size)
        })
    {
        return false;
    }
    if state.parts.iter().any(|part| part.blob_id == file.blob_id) {
        return false;
    }
    if state.blobs.iter().any(|existing| existing.id == file.blob_id) {
        return false;
    }

    if state.files.iter().any(|existing| existing.id == file.id) {
        file.id = Uuid::new_v4().to_string();
    }

    normalize_imported_file(&mut file, folder_ids);
    state.blobs.push(blob);
    state.parts.extend(parts);
    state.files.push(file);
    eprintln!("[TeleDrive] Recovered file record from {}.", source);
    true
}

/// Import file records from the WinUI state that shares the same data folder.
/// The WinUI build stored Telegram file ids under `tg_file_id` and part indexes
/// under `idx`; the native build uses different field names.
pub fn import_legacy_winui_state(state: &mut DatabaseState, data_dir: &Path) -> usize {
    let path = data_dir.join("teledrive-db.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return 0;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        eprintln!("[TeleDrive] Previous TeleDrive database is unreadable; skipping import.");
        return 0;
    };

    let mut legacy_parts: HashMap<String, Vec<LegacyPart>> = HashMap::new();
    if let Some(parts) = json.get("parts").and_then(|value| value.as_array()) {
        for value in parts {
            if let Ok(part) = serde_json::from_value::<LegacyPart>(value.clone()) {
                legacy_parts.entry(part.blob_id.clone()).or_default().push(part);
            }
        }
    }

    let folder_ids: HashSet<String> = state.folders.iter().map(|folder| folder.id.clone()).collect();
    let channel_id = crate::config::get_var("TELEGRAM_CHANNEL_ID").unwrap_or_default();
    let default_created = chrono::Utc::now().timestamp_millis();
    let mut imported = 0;

    let files = match json.get("files").and_then(|value| value.as_array()) {
        Some(files) => files.clone(),
        None => return 0,
    };

    for value in files {
        let Ok(mut file) = serde_json::from_value::<FileRecord>(value) else {
            continue;
        };
        if file.status != "ready" || file.blob_id.is_empty() || file.name.trim().is_empty() {
            continue;
        }
        let Some(raw_parts) = legacy_parts.get(&file.blob_id) else {
            continue;
        };

        let mut parts: Vec<PartRecord> = Vec::with_capacity(raw_parts.len());
        let mut usable = true;
        for part in raw_parts {
            if part.status != "stored"
                || !telegram_ref_is_usable(&part.tg_file_id, part.message_id)
            {
                usable = false;
                break;
            }
            parts.push(PartRecord {
                id: Uuid::new_v4().to_string(),
                blob_id: file.blob_id.clone(),
                part_index: part.idx,
                size: part.size,
                sha256: part.sha256.clone(),
                telegram_file_id: part.tg_file_id.clone(),
                telegram_message_id: part.message_id,
                telegram_channel_id: channel_id.clone(),
                bot_id: part.bot_id.clone(),
                created_at: file.created_at,
            });
        }
        if !usable {
            continue;
        }
        parts.sort_by_key(|part| part.part_index);

        let blob = BlobRecord {
            id: file.blob_id.clone(),
            size: file.size,
            sha256: content_sha(file.size, &parts),
            created_at: file.created_at,
        };
        if file.created_at <= 0 {
            file.created_at = default_created;
        }
        if file.updated_at <= 0 {
            file.updated_at = file.created_at;
        }
        if import_one(state, file, parts, blob, &folder_ids, "the previous TeleDrive database") {
            imported += 1;
        }
    }
    imported
}

/// Recover files that exist in the previous native state snapshot but are
/// missing from the current one (for example, after an interrupted save).
pub fn import_missing_from_backup(state: &mut DatabaseState, backup_path: &Path) -> usize {
    let Ok(raw) = std::fs::read_to_string(backup_path) else {
        return 0;
    };
    let Ok(backup) = serde_json::from_str::<DatabaseState>(&raw) else {
        return 0;
    };
    let folder_ids: HashSet<String> = state.folders.iter().map(|folder| folder.id.clone()).collect();
    let mut imported = 0;

    for file in backup.files {
        let mut parts: Vec<PartRecord> = backup
            .parts
            .iter()
            .filter(|part| part.blob_id == file.blob_id)
            .cloned()
            .collect();
        parts.sort_by_key(|part| part.part_index);
        let blob = backup
            .blobs
            .iter()
            .find(|blob| blob.id == file.blob_id)
            .cloned()
            .unwrap_or(BlobRecord {
                id: file.blob_id.clone(),
                size: file.size,
                sha256: content_sha(file.size, &parts),
                created_at: file.created_at,
            });
        if import_one(state, file, parts, blob, &folder_ids, "the previous state snapshot") {
            imported += 1;
        }
    }
    imported
}

#[derive(Debug)]
struct OrphanCandidate {
    blob_id: String,
    parts: Vec<PartRecord>,
    size: u64,
    created_at: i64,
}

#[derive(Debug)]
struct RecoveredInfo {
    name: String,
    mime_type: String,
}

fn name_from_caption(caption: &str) -> Option<String> {
    for line in caption.lines() {
        if let Some(value) = line.strip_prefix("file:") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Telegram gives multi-part documents names such as `movie.mkv.part3` or
/// `movie.mkv.part3.zip`. The original file name is everything before the
/// suffix.
fn original_name(raw: &str) -> String {
    let mut name = raw.trim().to_string();
    if name.is_empty() {
        return name;
    }
    if name.to_ascii_lowercase().ends_with(".zip") {
        name.truncate(name.len() - 4);
    }
    if let Some(position) = name.rfind(".part") {
        let suffix = &name[position + 5..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
            name.truncate(position);
        }
    }
    name.trim().to_string()
}

fn info_from_forwarded(message: &serde_json::Value) -> Option<RecoveredInfo> {
    let document = message.get("document");
    let mut raw_name = document
        .and_then(|value| value.get("file_name"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if raw_name.is_empty() {
        if let Some(name) = message
            .get("caption")
            .and_then(|value| value.as_str())
            .and_then(name_from_caption)
        {
            raw_name = name;
        }
    }
    let name = original_name(&raw_name);
    if name.is_empty() {
        return None;
    }
    let mime_type = document
        .and_then(|value| value.get("mime_type"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    Some(RecoveredInfo { name, mime_type })
}

fn bot_tokens_for(part: &PartRecord, bots: &[(String, String)]) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    if let Some((_, token)) = bots.iter().find(|(id, _)| id == &part.bot_id) {
        tokens.push(token.clone());
    }
    for (_, token) in bots {
        if !tokens.contains(token) {
            tokens.push(token.clone());
        }
    }
    tokens
}

/// Scan blobs that have Telegram parts but no file record, recover their
/// original names through a temporary forward, and add the missing records.
/// Superseded retry uploads are marked as scanned so they are not forwarded
/// again on every launch.
pub fn recover_orphan_telegram_files(server: &Arc<AppServer>) -> usize {
    let (candidates, bots) = {
        let state = server.db.state.read_safe();
        let referenced: HashSet<String> = state.files.iter().map(|file| file.blob_id.clone()).collect();
        let scanned: HashSet<String> = state.recovery_scanned_blobs.iter().cloned().collect();
        let mut by_blob: HashMap<String, Vec<PartRecord>> = HashMap::new();
        for part in &state.parts {
            by_blob.entry(part.blob_id.clone()).or_default().push(part.clone());
        }
        let mut candidates = Vec::new();
        for (blob_id, mut parts) in by_blob {
            if referenced.contains(&blob_id) || scanned.contains(&blob_id) {
                continue;
            }
            parts.sort_by_key(|part| part.part_index);
            let size = parts.iter().map(|part| part.size).sum();
            let created_at = parts.iter().map(|part| part.created_at).min().unwrap_or(0);
            candidates.push(OrphanCandidate {
                blob_id,
                parts,
                size,
                created_at,
            });
        }
        candidates.sort_by_key(|candidate| candidate.created_at);
        let bots: Vec<(String, String)> = state
            .bots
            .iter()
            .filter(|bot| !bot.token.is_empty())
            .map(|bot| (bot.id.clone(), bot.token.clone()))
            .collect();
        (candidates, bots)
    };

    if candidates.is_empty() {
        return 0;
    }

    let channel = server.telegram.channel_id.clone();
    let mut recovered: Vec<(OrphanCandidate, RecoveredInfo)> = Vec::new();
    let mut scanned_now: Vec<String> = Vec::new();
    let mut deferred = 0usize;

    for candidate in candidates {
        if candidate.size == 0 || candidate.parts.is_empty() {
            scanned_now.push(candidate.blob_id.clone());
            continue;
        }
        if candidate
            .parts
            .iter()
            .any(|part| !telegram_ref_is_usable(&part.telegram_file_id, part.telegram_message_id))
        {
            // Synthetic/placeholder parts cannot be downloaded. Remember the
            // blob so startup does not retry it forever.
            scanned_now.push(candidate.blob_id.clone());
            continue;
        }

        let mut info: Option<RecoveredInfo> = None;
        for part in &candidate.parts {
            for token in bot_tokens_for(part, &bots) {
                let result = server.tokio_runtime.block_on(server.telegram.forward_message(
                    &token,
                    &channel,
                    &channel,
                    part.telegram_message_id,
                ));
                match result {
                    Ok(message) => {
                        if let Some(forwarded_id) = message.get("message_id").and_then(|value| value.as_i64()) {
                            let _ = server.tokio_runtime.block_on(server.telegram.delete_message(
                                &token,
                                &channel,
                                forwarded_id,
                            ));
                        }
                        if let Some(parsed) = info_from_forwarded(&message) {
                            info = Some(parsed);
                            break;
                        }
                    }
                    Err(error) => {
                        eprintln!(
                            "[TeleDrive] Recovery could not read blob {} part {}: {}",
                            candidate.blob_id, part.part_index, error
                        );
                    }
                }
            }
            if info.is_some() {
                break;
            }
        }

        match info {
            Some(info) => {
                scanned_now.push(candidate.blob_id.clone());
                recovered.push((candidate, info));
            }
            None => deferred += 1,
        }
    }

    if recovered.is_empty() {
        if !scanned_now.is_empty() {
            let mut state = server.db.state.write_safe();
            for blob_id in scanned_now {
                if !state.recovery_scanned_blobs.contains(&blob_id) {
                    state.recovery_scanned_blobs.push(blob_id);
                }
            }
            drop(state);
            server.db.save();
        }
        if deferred > 0 {
            eprintln!(
                "[TeleDrive] {} orphaned Telegram upload(s) could not be read yet; will retry on next launch.",
                deferred
            );
        }
        return 0;
    }

    // Multiple retry uploads can share the same original name and size. Keep
    // the earliest complete one so the drive shows a single file and all later
    // duplicates stay untouched in Telegram.
    let mut groups: HashMap<(String, u64), Vec<(OrphanCandidate, RecoveredInfo)>> = HashMap::new();
    for (candidate, info) in recovered {
        groups
            .entry((info.name.to_lowercase(), candidate.size))
            .or_default()
            .push((candidate, info));
    }

    let now = chrono::Utc::now().timestamp_millis();
    let mut created = 0usize;
    {
        let mut state = server.db.state.write_safe();
        for (_, mut group) in groups {
            group.sort_by_key(|(candidate, _)| candidate.created_at);
            let (candidate, info) = group.remove(0);
            if state.files.iter().any(|file| {
                file.blob_id == candidate.blob_id
                    || (file.name.eq_ignore_ascii_case(&info.name) && file.size == candidate.size)
            }) {
                continue;
            }
            let mime_type = if info.mime_type.is_empty() {
                mime_from_name(&info.name)
            } else {
                info.mime_type.clone()
            };
            let extension = extension_from_name(&info.name);
            let category = detect_category(&mime_type, &extension).to_string();
            let created_at = if candidate.created_at > 0 {
                candidate.created_at
            } else {
                now
            };
            let file = FileRecord {
                id: Uuid::new_v4().to_string(),
                folder_id: None,
                blob_id: candidate.blob_id.clone(),
                name: info.name,
                extension,
                mime_type,
                category,
                size: candidate.size,
                status: "ready".to_string(),
                description: "Recovered from your Telegram storage channel".to_string(),
                tags: String::new(),
                starred: 0,
                has_thumbnail: 0,
                width: None,
                height: None,
                duration: None,
                metadata: None,
                taken_at: None,
                trashed_at: None,
                trash_root: 0,
                last_accessed_at: None,
                created_at,
                updated_at: now,
            };
            if !state.blobs.iter().any(|blob| blob.id == candidate.blob_id) {
                state.blobs.push(BlobRecord {
                    id: candidate.blob_id.clone(),
                    size: candidate.size,
                    sha256: content_sha(candidate.size, &candidate.parts),
                    created_at,
                });
            }
            eprintln!(
                "[TeleDrive] Recovered {} ({} bytes) from Telegram.",
                file.name, file.size
            );
            state.files.push(file);
            created += 1;
        }
        for blob_id in scanned_now {
            if !state.recovery_scanned_blobs.contains(&blob_id) {
                state.recovery_scanned_blobs.push(blob_id);
            }
        }
    }
    server.db.save();

    if deferred > 0 {
        eprintln!(
            "[TeleDrive] {} orphaned Telegram upload(s) could not be read yet; will retry on next launch.",
            deferred
        );
    }
    created
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "teledrive-recovery-{}-{}",
            tag,
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn empty_state() -> DatabaseState {
        serde_json::from_value(json!({
            "files": [],
            "folders": [],
            "blobs": [],
            "parts": [],
            "bots": []
        }))
        .unwrap()
    }

    fn legacy_file() -> serde_json::Value {
        json!({
            "id": "11111111-1111-4111-8111-111111111111",
            "folder_id": null,
            "blob_id": "22222222-2222-4222-8222-222222222222",
            "name": "holiday photo.png",
            "extension": "png",
            "mime_type": "image/png",
            "category": "image",
            "size": 10,
            "status": "ready",
            "description": "",
            "tags": "",
            "starred": 0,
            "has_thumbnail": 0,
            "width": null,
            "height": null,
            "duration": null,
            "metadata": null,
            "taken_at": null,
            "trashed_at": null,
            "trash_root": 0,
            "last_accessed_at": null,
            "created_at": 1700000000000i64,
            "updated_at": 1700000000000i64
        })
    }

    fn legacy_part() -> serde_json::Value {
        json!({
            "blob_id": "22222222-2222-4222-8222-222222222222",
            "idx": 0,
            "offset": 0,
            "size": 10,
            "sha256": "abc",
            "status": "stored",
            "bot_id": "123456",
            "message_id": 77,
            "tg_file_id": "BQACAgUAAyEGAAMBBg0S",
            "tg_file_unique_id": "AgADqC4AAgY1OFc",
            "attempts": 0,
            "last_error": null,
            "next_attempt_at": null
        })
    }

    #[test]
    fn imports_legacy_winui_records_once() {
        let dir = temp_dir("legacy");
        let raw = json!({
            "files": [legacy_file()],
            "parts": [legacy_part()]
        });
        std::fs::write(
            dir.join("teledrive-db.json"),
            serde_json::to_string_pretty(&raw).unwrap(),
        )
        .unwrap();

        let mut state = empty_state();
        assert_eq!(import_legacy_winui_state(&mut state, &dir), 1);
        assert_eq!(state.files.len(), 1);
        assert_eq!(state.parts.len(), 1);
        assert_eq!(state.blobs.len(), 1);
        assert_eq!(state.files[0].name, "holiday photo.png");
        assert_eq!(state.parts[0].telegram_message_id, 77);
        assert_eq!(state.parts[0].telegram_file_id, "BQACAgUAAyEGAAMBBg0S");
        assert!(parts_are_complete(&state.parts, state.files[0].size));

        // A second startup must not duplicate imported records.
        assert_eq!(import_legacy_winui_state(&mut state, &dir), 0);
        assert_eq!(state.files.len(), 1);
        assert_eq!(state.parts.len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn skips_legacy_records_with_synthetic_or_local_references() {
        let dir = temp_dir("synthetic");
        let mut part = legacy_part();
        part["tg_file_id"] = json!("part_22222222-2222-4222-8222-222222222222_0");
        part["message_id"] = json!(0);
        let raw = json!({
            "files": [legacy_file()],
            "parts": [part]
        });
        std::fs::write(
            dir.join("teledrive-db.json"),
            serde_json::to_string_pretty(&raw).unwrap(),
        )
        .unwrap();

        let mut state = empty_state();
        assert_eq!(import_legacy_winui_state(&mut state, &dir), 0);
        assert!(state.files.is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn imports_missing_file_from_backup_snapshot() {
        let dir = temp_dir("backup");
        let mut backup = empty_state();
        let file: FileRecord = serde_json::from_value(legacy_file()).unwrap();
        backup.files.push(file.clone());
        backup.parts.push(PartRecord {
            id: Uuid::new_v4().to_string(),
            blob_id: file.blob_id.clone(),
            part_index: 0,
            size: file.size,
            sha256: "abc".to_string(),
            telegram_file_id: "BQACAgUAAyEGAAMBBg0S".to_string(),
            telegram_message_id: 77,
            telegram_channel_id: "-1001".to_string(),
            bot_id: "123456".to_string(),
            created_at: file.created_at,
        });
        backup.blobs.push(BlobRecord {
            id: file.blob_id.clone(),
            size: file.size,
            sha256: "def".to_string(),
            created_at: file.created_at,
        });
        let path = dir.join("teledrive.json.bak");
        std::fs::write(&path, serde_json::to_string_pretty(&backup).unwrap()).unwrap();

        let mut state = empty_state();
        assert_eq!(import_missing_from_backup(&mut state, &path), 1);
        assert_eq!(state.files.len(), 1);
        assert_eq!(import_missing_from_backup(&mut state, &path), 0);
        assert_eq!(state.files.len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn strips_multi_part_suffixes_from_document_names() {
        assert_eq!(original_name("movie.mkv.part3"), "movie.mkv");
        assert_eq!(original_name("movie.mkv.part3.zip"), "movie.mkv");
        assert_eq!(original_name("TeleDrive-Setup.msi.part0"), "TeleDrive-Setup.msi");
        assert_eq!(original_name("notes.partial.txt"), "notes.partial.txt");
    }

    #[test]
    fn reads_names_from_forwarded_documents_and_captions() {
        let forwarded = json!({
            "document": { "file_name": "movie.mkv.part2", "mime_type": "video/x-matroska" }
        });
        let info = info_from_forwarded(&forwarded).unwrap();
        assert_eq!(info.name, "movie.mkv");
        assert_eq!(info.mime_type, "video/x-matroska");

        let captioned = json!({ "caption": "TeleDrive part 1/2\nfile: report.pdf" });
        let info = info_from_forwarded(&captioned).unwrap();
        assert_eq!(info.name, "report.pdf");
    }

    /// Not run in normal CI: validates recovery against copies of the user's
    /// live data directory. Run with
    /// `TELEDRIVE_RECOVERY_LIVE_DIR=<dir> cargo test ... -- --ignored`.
    #[test]
    #[ignore]
    fn imports_live_state_copies() {
        let Ok(dir) = std::env::var("TELEDRIVE_RECOVERY_LIVE_DIR") else {
            return;
        };
        let dir = std::path::PathBuf::from(dir);
        let raw = std::fs::read_to_string(dir.join("teledrive.json")).unwrap();
        let mut state: DatabaseState = serde_json::from_str(&raw).unwrap();
        let before = state.files.len();
        let imported = import_legacy_winui_state(&mut state, &dir);
        let backup = import_missing_from_backup(&mut state, &dir.join("teledrive.json.bak"));
        assert_eq!(imported, 10, "expected ten legacy file records");
        assert_eq!(backup, 0, "backup snapshot has no extra files");
        assert_eq!(state.files.len(), before + imported + backup);
        assert_eq!(
            import_legacy_winui_state(&mut state, &dir),
            0,
            "second import must be a no-op"
        );
    }
}

