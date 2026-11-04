use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::sync_ext::MutexExt;

pub struct BotApiProcess {
    pub url: String,
    port: u16,
    child: Mutex<Option<Child>>,
    startup_error: Option<String>,
    /// Windows Job Object with KILL_ON_JOB_CLOSE — kills the child if this
    /// process dies for any reason. Held for the process lifetime; never
    /// closed early.
    job: Mutex<Option<crate::sync_ext::JobHandle>>,
}

impl BotApiProcess {
    pub fn start(data_dir: &Path) -> Self {
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .map(|addr| addr.port())
            .unwrap_or(8081);
        let mut service = Self {
            url: format!("http://127.0.0.1:{port}"),
            port,
            child: Mutex::new(None),
            startup_error: None,
            job: Mutex::new(None),
        };
        if let Err(error) = service.launch(data_dir) {
            service.startup_error = Some(error);
            // Retry once after a short delay — a slow first-write of the Bot
            // API working dir can race the readiness probe.
            std::thread::sleep(Duration::from_secs(1));
            if let Err(e2) = service.launch(data_dir) {
                service.startup_error = Some(e2);
            } else {
                service.startup_error = None;
            }
        }
        service
    }

    fn launch(&mut self, data_dir: &Path) -> Result<(), String> {
        let api_id = crate::config::get_var("TELEGRAM_API_ID")
            .ok_or("Telegram API ID is not configured (set TELEGRAM_API_ID in .env)")?;
        let api_hash = crate::config::get_var("TELEGRAM_API_HASH")
            .ok_or("Telegram API hash is not configured (set TELEGRAM_API_HASH in .env)")?;
        let exe = std::env::current_exe()
            .map_err(|e| format!("Cannot locate application: {e}"))?
            .parent().ok_or("Cannot locate application directory")?
            .join("bot-api").join("telegram-bot-api.exe");
        if !exe.is_file() {
            return Err("Bundled telegram-bot-api.exe is missing. Reinstall TeleDriveR.".into());
        }
        let work = data_dir.join("bot-api");
        let temp = work.join("temp");
        std::fs::create_dir_all(&temp).map_err(|e| format!("Cannot create Bot API data directory: {e}"))?;
        let mut cmd = Command::new(exe);
        cmd.arg("--local")
            .arg("--http-ip-address=127.0.0.1")
            .arg(format!("--http-port={}", self.port))
            .arg(format!("--dir={}", work.display()))
            .arg(format!("--temp-dir={}", temp.display()))
            .arg(format!("--log={}", work.join("bot-api.log").display()))
            .arg("--log-max-file-size=10485760")
            .arg("--stats-hide-sensible-data")
            .env("TELEGRAM_API_ID", api_id)
            .env("TELEGRAM_API_HASH", api_hash)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd.spawn().map_err(|e| format!("Cannot launch bundled Bot API: {e}"))?;
        #[cfg(target_os = "windows")]
        crate::sync_ext::assign_to_kill_job(&child, &self.job);
        *self.child.lock_safe() = Some(child);

        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if self.ready() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        Err("Bundled Bot API did not start within 20 seconds; check bot-api.log in app data".into())
    }

    pub fn ready(&self) -> bool {
        let mut child = self.child.lock_safe();
        if child.as_mut().is_none_or(|process| process.try_wait().ok().flatten().is_some()) {
            return false;
        }
        TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", self.port).parse().unwrap(),
            Duration::from_millis(300),
        ).is_ok()
    }

    pub fn check_available(&self) -> Result<(), String> {
        if self.ready() {
            Ok(())
        } else {
            Err(format!("Self-hosted Bot API unavailable: {}", self.startup_error.as_deref()
                .unwrap_or("the bundled service stopped; restart TeleDriveR")))
        }
    }

    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock_safe().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for BotApiProcess {
    fn drop(&mut self) {
        self.stop();
    }
}
