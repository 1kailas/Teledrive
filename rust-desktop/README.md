# TeleDrive — Native Rust Windows Application

A native Rust Windows desktop application for TeleDrive, rendered with egui/eframe (no WebView2 or JavaScript runtime). The installer includes the self-hosted Telegram Bot API executable and its DLLs; no separate bot server, Node, or Docker installation is required.

## 🚀 Key Highlights
- **Installer**: `TeleDriveR-Setup.msi` includes `TeleDriveR.exe`, `telegram-bot-api.exe`, OpenSSL and zlib DLLs.
- **Embedded HTTP Server**: Multi-threaded `tiny_http` server running locally on loopback for the desktop UI and automation API.
- **Native Windowing**: Powered by `eframe`/`egui` with a native Win32 window, custom titlebar, and no WebView2 dependency.
- **Storage Engine**: New files go to a private Telegram channel via the bundled local Bot API. The local `vault` folder is retained only to read legacy files; no new uploads go there.
- **Disk Awareness**: Reports real Windows free/total disk space, blocks uploads that would fill the drive (HTTP 507), and shows free capacity in the sidebar and settings.
- **Self-Maintaining Storage**: 30-day trash expiry, orphaned-part cleanup on startup/daily, automatic finalization of uploads whose bytes already reached Telegram, and a **Verify drive** health check in Settings → System.
- **Transfer Engine**: Resumable slice uploads with persisted sessions, pause/resume downloads over HTTP Range, and large-file streaming to disk so multi-GB downloads do not sit in browser memory. Chunk size is adjustable from 5 MB to 2000 MB.
- **Local ZIP Downloads**: Selecting multiple files or a folder builds a stored ZIP archive on disk and streams it through the embedded server.
- **Loopback Hardening**: The local API rejects foreign Host/Origin headers and requires the `X-Requested-With: teledrive` header on every state-changing request, blocking cross-site access to the drive.
- **Data Persistence**: Metadata lives in `%APPDATA%\TeleDrive\data\teledrive.json`, temporary staging in `data\uploads`, and the Bot API's own TDLib state/cache in `data\bot-api`. Back up the metadata file; bot tokens and API credentials are embedded in the app and must be kept private. The installer can carry a `.env` with the Telegram API credentials so a fresh install works without manual setup.

---

## 📦 Directory Structure
```
rust-desktop/
├── Cargo.toml               # Rust package definition with x86_64-pc-windows-gnu configuration
├── src/
│   ├── main.rs              # Application entrypoint, eframe window & startup recovery
│   ├── models.rs            # Data structures and API DTO models
│   ├── db.rs                # Embedded database engine with APPDATA persistence & metadata index
│   ├── server.rs            # Embedded tiny_http HTTP REST API & static asset router
│   ├── recovery.rs          # Legacy-database import & orphaned Telegram upload recovery
│   └── telegram.rs          # Multi-bot parallel Telegram API transfer client
├── resources/
│   ├── icon.ico             # Native Windows application icon
│   ├── icon.png             # UI and titlebar assets
│   └── icon-256.png         # Installer icon
├── scripts/
│   └── build-msi.js         # WiX packaging script producing TeleDriveR-Setup.msi
└── release/
    └── TeleDriveR-Setup.msi  # Standalone Windows MSI installer
```

---

## 🛠️ Build Commands (from repo root)

### Build Native Executable
```bash
npm run rust:build
```
Builds `rust-desktop/target/x86_64-pc-windows-gnu/release/TeleDriveR.exe` with LTO and binary stripping. The build machine needs the pinned Rust target and WiX; the installed app does not.

### Package Windows MSI Installer
```bash
npm run rust:msi
```
Packages `TeleDriveR-Setup.msi` and automatically delivers it to:
- `C:\Users\Kailasnath T\Desktop\TeleDriveR-Setup.msi`
- `C:\Users\Kailasnath T\Downloads\TeleDriveR-Setup.msi`
- `rust-desktop/release/TeleDriveR-Setup.msi`
- Workspace root: `TeleDriveR-Setup.msi`
