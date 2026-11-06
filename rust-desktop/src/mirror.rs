use std::path::Path;
use std::sync::Arc;
use chrono::Utc;
use crate::db::Database;
use crate::models::{FileRecord, FolderRecord};
use crate::sync_ext::RwLockExt;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorSyncStats {
    pub enabled: bool,
    pub path: String,
    pub synced_files: usize,
    pub synced_folders: usize,
    pub total_size_bytes: u64,
    pub last_sync_at: i64,
    pub error: Option<String>,
}

pub struct MirrorEngine {
    db: Arc<Database>,
}

impl MirrorEngine {
    pub fn new(db: Arc<Database>) -> Self {
        Self { db }
    }

    /// Synchronizes the Metadata & Cache directory at `mirror_root`.
    /// Stores the metadata catalog (.teledrive/catalog.json), streaming cache (cache/),
    /// and thumbnails (thumbnails/).
    /// Does NOT replicate dummy/backup copies of cloud files to avoid duplicate storage.
    pub fn sync(&self, mirror_root_str: &str) -> MirrorSyncStats {
        let mirror_root = Path::new(mirror_root_str);
        if let Err(e) = std::fs::create_dir_all(mirror_root) {
            return MirrorSyncStats {
                enabled: true,
                path: mirror_root_str.to_string(),
                synced_files: 0,
                synced_folders: 0,
                total_size_bytes: 0,
                last_sync_at: Utc::now().timestamp_millis(),
                error: Some(format!("Cannot access or create cache directory: {}", e)),
            };
        }

        let state = self.db.state.read_safe();
        let active_folders: Vec<FolderRecord> = state.folders.iter()
            .filter(|f| f.trashed_at.is_none())
            .cloned()
            .collect();
        let active_files: Vec<FileRecord> = state.files.iter()
            .filter(|f| f.trashed_at.is_none())
            .cloned()
            .collect();
        let blobs = state.blobs.clone();
        let parts = state.parts.clone();
        drop(state);

        // Build folder path hierarchy
        let mut folder_path_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
        for _ in 0..15 {
            for f in &active_folders {
                if let Some(ref pid) = f.parent_id {
                    if let Some(parent_path) = folder_path_map.get(pid).cloned() {
                        folder_path_map.insert(f.id.clone(), format!("{}/{}", parent_path, f.name));
                    }
                } else {
                    folder_path_map.insert(f.id.clone(), format!("/{}", f.name));
                }
            }
        }

        // Precompute blob hashes and part counts
        let blob_hash_map: std::collections::HashMap<&str, &str> = blobs.iter()
            .map(|b| (b.id.as_str(), b.sha256.as_str()))
            .collect();

        let mut part_count_map: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for p in &parts {
            *part_count_map.entry(&p.blob_id).or_insert(0) += 1;
        }

        // Category breakdown statistics
        let mut cat_counts: std::collections::HashMap<String, (usize, u64)> = std::collections::HashMap::new();
        for f in &active_files {
            let entry = cat_counts.entry(f.category.clone()).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += f.size;
        }

        // 1. Ensure required cache and metadata directories exist
        let meta_dir = mirror_root.join(".teledrive");
        let cache_dir = mirror_root.join("cache");
        let thumbs_dir = mirror_root.join("thumbnails");
        let _ = std::fs::create_dir_all(&meta_dir);
        let _ = std::fs::create_dir_all(&cache_dir);
        let _ = std::fs::create_dir_all(&thumbs_dir);

        // 2. (removed) Earlier builds deleted every unknown entry in the mirror
        // root — TeleDrive must never delete anything it did not create.

        // 3. Write enhanced catalog.json inside .teledrive/
        let catalog_path = meta_dir.join("catalog.json");
        let total_cloud_size: u64 = active_files.iter().map(|f| f.size).sum();

        let category_stats_json = serde_json::Value::Object(
            cat_counts.into_iter().map(|(k, (count, bytes))| {
                (k, serde_json::json!({ "count": count, "totalBytes": bytes }))
            }).collect()
        );

        let catalog = serde_json::json!({
            "version": 2,
            "generatedAt": Utc::now().timestamp_millis(),
            "mirrorPath": mirror_root_str,
            "summary": {
                "totalFiles": active_files.len(),
                "totalFolders": active_folders.len(),
                "totalCloudSizeBytes": total_cloud_size,
                "byCategory": category_stats_json,
            },
            "folders": active_folders.iter().map(|f| {
                let p = folder_path_map.get(&f.id).cloned().unwrap_or_else(|| format!("/{}", f.name));
                serde_json::json!({
                    "id": f.id,
                    "parentId": f.parent_id,
                    "name": f.name,
                    "path": p,
                    "starred": f.starred != 0,
                    "createdAt": f.created_at,
                    "updatedAt": f.updated_at,
                })
            }).collect::<Vec<_>>(),
            "files": active_files.iter().map(|f| {
                let folder_p = f.folder_id.as_ref()
                    .and_then(|fid| folder_path_map.get(fid))
                    .map(|p| p.as_str())
                    .unwrap_or("/");
                let full_path = if folder_p == "/" {
                    format!("/{}", f.name)
                } else {
                    format!("{}/{}", folder_p, f.name)
                };
                let sha = blob_hash_map.get(f.blob_id.as_str()).copied().unwrap_or("");
                let pcount = part_count_map.get(f.blob_id.as_str()).copied().unwrap_or(0);
                let meta_obj: serde_json::Value = f.metadata.as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or(serde_json::Value::Null);

                serde_json::json!({
                    "id": f.id,
                    "folderId": f.folder_id,
                    "name": f.name,
                    "extension": f.extension,
                    "path": full_path,
                    "size": f.size,
                    "mimeType": f.mime_type,
                    "category": f.category,
                    "sha256": sha,
                    "partCount": pcount,
                    "hasThumbnail": f.has_thumbnail != 0,
                    "thumbnailRelPath": if f.has_thumbnail != 0 { Some(format!("thumbnails/{}.jpg", f.id)) } else { None },
                    "width": f.width,
                    "height": f.height,
                    "duration": f.duration,
                    "starred": f.starred != 0,
                    "tags": if f.tags.is_empty() { vec![] } else { f.tags.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>() },
                    "description": f.description,
                    "metadata": meta_obj,
                    "takenAt": f.taken_at,
                    "createdAt": f.created_at,
                    "updatedAt": f.updated_at,
                })
            }).collect::<Vec<_>>()
        });
        if let Ok(json_str) = serde_json::to_string_pretty(&catalog) {
            let _ = std::fs::write(&catalog_path, json_str);
        }

        // 4. Measure actual real cache storage used on disk
        let mut cached_files_count = 0usize;
        let mut cached_bytes = 0u64;

        fn measure_dir(dir: &Path, count: &mut usize, bytes: &mut u64) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        *count += 1;
                        if let Ok(meta) = p.metadata() {
                            *bytes += meta.len();
                        }
                    } else if p.is_dir() {
                        measure_dir(&p, count, bytes);
                    }
                }
            }
        }

        measure_dir(&cache_dir, &mut cached_files_count, &mut cached_bytes);
        measure_dir(&thumbs_dir, &mut cached_files_count, &mut cached_bytes);
        if let Ok(m) = catalog_path.metadata() {
            cached_bytes += m.len();
        }

        MirrorSyncStats {
            enabled: true,
            path: mirror_root_str.to_string(),
            synced_files: cached_files_count,
            synced_folders: active_folders.len(),
            total_size_bytes: cached_bytes,
            last_sync_at: Utc::now().timestamp_millis(),
            error: None,
        }
    }
}
