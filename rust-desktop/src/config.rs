use std::path::PathBuf;

/// Load configuration from `.env` file into process environment variables.
/// Looks in common locations, in priority order:
/// 1. Current working directory (`.env`)
/// 2. Executable directory (`<exe_dir>/.env`) — this is where the MSI puts
///    the bundled configuration when one is included at build time.
/// 3. Parent directory (`../.env`)
/// 4. Roaming application data directory (`%APPDATA%/TeleDrive/.env` and
///    `%APPDATA%/TeleDriveR/.env`). The native app keeps its data in
///    `%APPDATA%/TeleDrive`, so credentials placed there by earlier builds
///    must still be found after upgrading.
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
        candidate_paths.push(data.join("TeleDrive").join(".env"));
        candidate_paths.push(data.join("TeleDrive").join("data").join(".env"));
        candidate_paths.push(data.join("TeleDriveR").join(".env"));
        candidate_paths.push(data.join("TeleDriveR").join("data").join(".env"));
    }

    // Merge every candidate instead of stopping at the first file: a bundled
    // file can carry only the Telegram credentials while the per-user file
    // adds the bot fleet. Existing process variables always win.
    let mut seen = std::collections::HashSet::new();
    for path in candidate_paths {
        if !seen.insert(path.clone()) || !path.is_file() {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            parse_dotenv_content(&content);
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
            // Treat an empty inherited variable as unset. Launchers often
            // define TELEGRAM_* variables with empty values, which would
            // otherwise shadow the real credentials in .env.
            match std::env::var(key) {
                Ok(existing) if !existing.trim().is_empty() => {}
                _ => std::env::set_var(key, val),
            }
        }
    }
}

pub fn get_var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}
