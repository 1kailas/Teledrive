use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRecord {
    pub id: String,
    #[serde(default)]
    pub folder_id: Option<String>,
    pub blob_id: String,
    pub name: String,
    pub extension: String,
    pub mime_type: String,
    pub category: String,
    pub size: u64,
    pub status: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default)]
    pub starred: i64,
    #[serde(default)]
    pub has_thumbnail: i64,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub height: Option<i64>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub metadata: Option<String>,
    #[serde(default)]
    pub taken_at: Option<i64>,
    #[serde(default)]
    pub trashed_at: Option<i64>,
    #[serde(default)]
    pub trash_root: i64,
    #[serde(default)]
    pub last_accessed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderRecord {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub starred: i64,
    #[serde(default)]
    pub trashed_at: Option<i64>,
    #[serde(default)]
    pub trash_root: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobRecord {
    pub id: String,
    pub size: u64,
    pub sha256: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartRecord {
    pub id: String,
    pub blob_id: String,
    pub part_index: i64,
    pub size: u64,
    pub sha256: String,
    pub telegram_file_id: String,
    pub telegram_message_id: i64,
    pub telegram_channel_id: String,
    pub bot_id: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotRecord {
    pub id: String,
    pub username: String,
    pub token: String,
    pub healthy: bool,
    #[serde(default)]
    pub in_flight: i64,
    #[serde(default)]
    pub parts_uploaded: i64,
    #[serde(default)]
    pub bytes_uploaded: u64,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub admin_username: String,
    pub admin_password: String,
    pub telegram_channel_id: String,
    pub telegram_bot_api_url: String,
    pub part_size_mb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDTO {
    pub id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub extension: String,
    pub mime_type: String,
    pub category: String,
    pub size: u64,
    pub status: String,
    pub description: String,
    pub tags: Vec<String>,
    pub starred: bool,
    pub has_thumbnail: bool,
    pub thumbnail_url: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration: Option<f64>,
    pub metadata: Option<serde_json::Value>,
    pub taken_at: Option<i64>,
    pub part_count: usize,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_accessed_at: Option<i64>,
    pub trashed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDTO {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub color: Option<String>,
    pub starred: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub trashed_at: Option<i64>,
    pub child_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Breadcrumb {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilter {
    pub q: String,
    pub category: Option<String>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub folder_id: Option<String>,
    pub starred: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveResponse {
    pub folder: Option<FolderDTO>,
    pub breadcrumbs: Vec<Breadcrumb>,
    pub folders: Vec<FolderDTO>,
    pub files: Vec<FileDTO>,
    pub total_files: usize,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadPartDTO {
    pub idx: usize,
    pub offset: u64,
    pub size: u64,
    pub slice_count: usize,
    pub status: String,
    pub received_slices: Vec<usize>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadDTO {
    pub id: String,
    pub file_id: String,
    pub name: String,
    pub size: u64,
    pub part_size: u64,
    pub slice_size: u64,
    pub status: String,
    pub parts: Vec<UploadPartDTO>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCategory {
    pub category: String,
    pub count: usize,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBot {
    pub bot_id: String,
    pub username: Option<String>,
    pub healthy: bool,
    pub parts_uploaded: i64,
    pub bytes_uploaded: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsResponse {
    pub total_size: u64,
    pub file_count: usize,
    pub folder_count: usize,
    pub trash_size: u64,
    pub trash_count: usize,
    pub by_category: Vec<StatsCategory>,
    pub uploads_by_day: Vec<serde_json::Value>,
    pub largest_files: Vec<FileDTO>,
    pub bots: Vec<StatsBot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemBot {
    pub bot_id: String,
    pub username: Option<String>,
    pub healthy: bool,
    pub last_error: Option<String>,
    pub in_flight: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfoResponse {
    pub version: String,
    pub uptime_sec: u64,
    pub bot_api: serde_json::Value,
    pub channel: serde_json::Value,
    pub bots: Vec<SystemBot>,
    pub disk: serde_json::Value,
    pub cache: serde_json::Value,
    pub tools: serde_json::Value,
    pub queue: serde_json::Value,
    pub last_backup: Option<serde_json::Value>,
}

pub fn detect_category(mime: &str, ext: &str) -> &'static str {
    let ext_lower = ext.trim_start_matches('.').to_ascii_lowercase();
    let m = mime.to_ascii_lowercase();
    if m.starts_with("image/") || matches!(ext_lower.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "bmp" | "ico" | "tiff" | "tif" | "heic" | "heif" | "raw" | "nef" | "cr2" | "arw") {
        "image"
    } else if m.starts_with("video/") || matches!(ext_lower.as_str(), "mp4" | "mkv" | "webm" | "mov" | "avi" | "flv" | "wmv" | "m4v" | "3gp" | "ts" | "mts" | "m2ts" | "vob" | "ogv") {
        "video"
    } else if m.starts_with("audio/") || matches!(ext_lower.as_str(), "mp3" | "wav" | "flac" | "m4a" | "ogg" | "opus" | "aac" | "wma" | "alac" | "aiff") {
        "audio"
    } else if matches!(ext_lower.as_str(), "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "dmg" | "zst" | "tgz") {
        "archive"
    } else if matches!(ext_lower.as_str(), "js" | "ts" | "jsx" | "tsx" | "py" | "go" | "rs" | "java" | "c" | "cpp" | "h" | "hpp" | "cs" | "php" | "html" | "css" | "json" | "yaml" | "yml" | "sh" | "bash" | "sql" | "toml" | "xml") {
        "code"
    } else if m.starts_with("text/") || matches!(ext_lower.as_str(), "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "md" | "rtf" | "csv" | "epub" | "odt" | "ods" | "odp") {
        "document"
    } else {
        "other"
    }
}
