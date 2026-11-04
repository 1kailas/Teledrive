use std::path::PathBuf;

/// Load configuration from `.env` file into process environment variables.
/// Looks in common locations:
/// 1. Current working directory (`.env`)
/// 2. Executable directory (`<exe_dir>/.env`)
/// 3. Parent directory (`../.env`)
/// 4. Roaming application data directory (`%APPDATA%/TeleDriveR/.env`)
pub fn load_dotenv() {
    let mut candidate_paths: Vec<PathBuf> = vec![
        PathBuf::from(".env"),
        PathBuf::from("../.env"),
    ];

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidate_paths.push(parent.join(".env"));
            if let Some(grandparent) = parent.parent() {
                candidate_paths.push(grandparent.join(".env"));
            }
        }
    }

    if let Some(data) = dirs::data_dir() {
        candidate_paths.push(data.join("TeleDriveR").join(".env"));
    }

    for path in candidate_paths {
        if path.is_file() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                parse_dotenv_content(&content);
                break;
            }
        }
    }
}

fn parse_dotenv_content(content: &str) {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, val)) = trimmed.split_once('=') {
            let key = key.trim();
            let mut val = val.trim();
            if (val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')) {
                if val.len() >= 2 {
                    val = &val[1..val.len() - 1];
                }
            }
            if std::env::var(key).is_err() {
                std::env::set_var(key, val);
            }
        }
    }
}

pub fn get_var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}
