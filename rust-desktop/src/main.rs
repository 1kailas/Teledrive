#![windows_subsystem = "windows"]

mod models;
pub mod config;
mod db;
mod telegram;
mod server;
mod bot_api;
mod mirror;
mod sync_ext;
mod part_stream;
mod native_uploads;
mod native_downloads;
mod ui;

use std::sync::Arc;
use eframe::egui;

use crate::db::Database;
use crate::bot_api::BotApiProcess;
use crate::server::AppServer;
use crate::telegram::TelegramEngine;

static ICON_RGBA_32: &[u8] = include_bytes!("../resources/icon_rgba_32.bin");

#[cfg(target_os = "windows")]
fn already_running() -> bool {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            lpMutexAttributes: *const std::ffi::c_void,
            bInitialOwner: i32,
            lpName: *const u16,
        ) -> *mut std::ffi::c_void;
        fn GetLastError() -> u32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> *mut std::ffi::c_void;
        fn ShowWindow(hwnd: *mut std::ffi::c_void, cmd: i32) -> i32;
        fn SetForegroundWindow(hwnd: *mut std::ffi::c_void) -> i32;
        fn IsIconic(hwnd: *mut std::ffi::c_void) -> i32;
        fn IsWindowVisible(hwnd: *mut std::ffi::c_void) -> i32;
    }

    let name: Vec<u16> = std::ffi::OsStr::new("Local\\TeleDriveR-SingleInstance")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 1, name.as_ptr()) };
    if handle.is_null() {
        return false;
    }
    if unsafe { GetLastError() } == 183 {
        let title: Vec<u16> = std::ffi::OsStr::new("TeleDriveR — Native Cloud File Explorer")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        if !hwnd.is_null() {
            unsafe {
                if IsIconic(hwnd) != 0 {
                    ShowWindow(hwnd, 9); // SW_RESTORE
                } else if IsWindowVisible(hwnd) == 0 {
                    ShowWindow(hwnd, 5); // SW_SHOW
                }
                SetForegroundWindow(hwnd);
            }
        }
        return true;
    }
    false
}

#[cfg(not(target_os = "windows"))]
fn already_running() -> bool {
    false
}

fn get_available_port(preferred: u16) -> u16 {
    if std::net::TcpListener::bind(format!("127.0.0.1:{}", preferred)).is_ok() {
        return preferred;
    }
    if let Ok(listener) = std::net::TcpListener::bind("127.0.0.1:0") {
        if let Ok(addr) = listener.local_addr() {
            return addr.port();
        }
    }
    preferred
}

fn main() {
    crate::config::load_dotenv();
    let is_daemon = std::env::args().any(|a| a == "--daemon" || a == "--headless" || a == "-d");
    if !is_daemon && already_running() {
        return;
    }
    let tokio_runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Failed to initialize Tokio runtime"),
    );
    let port = get_available_port(48291);
    let db = Arc::new(Database::init());
    let bot_api = Arc::new(BotApiProcess::start(&db.data_dir));
    let telegram = Arc::new(TelegramEngine::new(Arc::clone(&db), Arc::clone(&bot_api)));
    let server = Arc::new(AppServer::new(Arc::clone(&db), Arc::clone(&telegram), Arc::clone(&tokio_runtime), port));

    server.start();

    // Write daemon info to data_dir and LocalAppData so WinUI 3 can immediately detect active port
    let daemon_info = serde_json::json!({
        "port": port,
        "pid": std::process::id(),
        "version": "3.1.7",
        "startedAt": chrono::Utc::now().timestamp_millis()
    });
    let daemon_file = db.data_dir.join("daemon.json");
    let _ = std::fs::write(&daemon_file, daemon_info.to_string());

    if is_daemon {
        println!("TeleDrive background daemon running on http://127.0.0.1:{}", port);
        // Headless daemon loop
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }

    let icon_data = egui::IconData {
        rgba: ICON_RGBA_32.to_vec(),
        width: 32,
        height: 32,
    };

    let native_options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 800.0])
            .with_min_inner_size([960.0, 600.0])
            .with_title("TeleDriveR — Native Cloud File Explorer")
            .with_icon(icon_data),
        ..Default::default()
    };

    let bot_api_clone = Arc::clone(&bot_api);
    let _ = eframe::run_native(
        "TeleDriveR",
        native_options,
        Box::new(move |_cc| {
            egui_extras::install_image_loaders(&_cc.egui_ctx);
            Ok(Box::new(ui::TeleDriveApp::new(
                db,
                server,
                bot_api,
                tokio_runtime,
            )))
        }),
    );

    bot_api_clone.stop();
}
