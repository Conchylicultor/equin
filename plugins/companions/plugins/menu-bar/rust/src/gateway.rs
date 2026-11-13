//! The gateway, seen from outside: whether anything answers on its port, and
//! starting its login service (`infra/launcher`'s `GATEWAY_SERVICE`), whose
//! launchd label / systemd unit the helper's own job carries in
//! `EQUIN_GATEWAY_LABEL` — the label the service is bound to on this machine,
//! which an install not yet migrated keeps from before the rename.

use std::net::{SocketAddr, TcpStream};
use std::process::Command;
use std::time::{Duration, Instant};

/// The gateway's port (`infra/namespace`'s GATEWAY_PORT).
pub const PORT: u16 = 9000;
/// What the helper's login-service job sets to the gateway's label
/// (`menu-bar/login-services`).
const LABEL_ENV: &str = "EQUIN_GATEWAY_LABEL";

/// Whether something accepts connections on the gateway's port.
pub fn up() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn label() -> Result<String, String> {
    std::env::var(LABEL_ENV).ok().filter(|l| !l.is_empty()).ok_or_else(|| {
        format!(
            "{LABEL_ENV} is not set, so the helper does not know the gateway's service — restart it with ./equin start --only dev.equin.menu-bar --force"
        )
    })
}

fn start_argv(label: &str) -> Vec<String> {
    if cfg!(target_os = "macos") {
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { getuid() };
        vec![
            "launchctl".into(),
            "kickstart".into(),
            "-k".into(),
            format!("gui/{uid}/{label}"),
        ]
    } else {
        vec![
            "systemctl".into(),
            "--user".into(),
            "start".into(),
            format!("{label}.service"),
        ]
    }
}

extern "C" {
    fn getuid() -> u32;
}

/// Start the gateway's login service and wait for its port to answer.
///
/// The wait is a bounded readiness probe after a user's click, not a watch:
/// the gateway's absence has no signal an outside process can subscribe to
/// (a refused connection is the only one), so the helper connects every
/// 250 ms for at most 30 s and then reports failure.
pub fn start() -> Result<(), String> {
    let argv = start_argv(&label()?);
    let out = Command::new(&argv[0])
        .args(&argv[1..])
        .output()
        .map_err(|e| format!("{}: {e}", argv.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "{} failed ({}): {}",
            argv.join(" "),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if up() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!(
        "the gateway service started but nothing answers on port {PORT} after 30 s — see ./equin start"
    ))
}
