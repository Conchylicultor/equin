//! The gateway, seen from outside: which port it listens on (the port file),
//! whether anything answers there, and starting its login service
//! (`infra/launcher`'s `GATEWAY_SERVICE`), whose launchd label / systemd unit
//! the helper's own job carries in `EQUIN_GATEWAY_LABEL` — the label the
//! service is bound to on this machine, which an install not yet migrated
//! keeps from before the rename.
//!
//! **The port** is this account's, chosen once by `./equin start` and written
//! to `~/.equin/state/gateway-port/port.json` (`{"port": <u16>, "legacy":
//! <u16|null>}`) only once a gateway listens there. The helper's job names the
//! file in `EQUIN_GATEWAY_PORT_FILE` (TS owns the layout:
//! `menu-bar/login-services`), and every probe / show reads it again — it is
//! one small file, and the port moves under a running tray when an install
//! migrates.
//!
//! A process the job did not start (an app window launched from its shim by
//! macOS or the desktop) has no `EQUIN_GATEWAY_PORT_FILE`: it does not know the
//! port ([`Port::NotProvided`]), and so never moves a URL onto one.

use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Deserialize;

/// The port an install that has not moved yet runs its gateway on: no port
/// file means the gateway was started before the port became a per-account
/// setting, and such a gateway always listened here (`infra/namespace`'s
/// LEGACY_GATEWAY_PORT). Only for a caller that must dial the gateway now
/// ([`Port::listening`]); never a port to move a URL onto.
pub const LEGACY_PORT: u16 = 9000;
/// What the helper's login-service job sets to the gateway's port file.
const PORT_FILE_ENV: &str = "EQUIN_GATEWAY_PORT_FILE";
/// What the helper's login-service job sets to the gateway's label
/// (`menu-bar/login-services`).
const LABEL_ENV: &str = "EQUIN_GATEWAY_LABEL";

/// The port file's shape (`gateway-port`'s zod schema).
#[derive(Deserialize)]
struct PortFile {
    port: u16,
    /// The port the gateway still answers on for a while after a move (read,
    /// not used: the helper always talks to the current one).
    #[allow(dead_code)]
    legacy: Option<u16>,
}

/// The port file's text → its port. Anything else is an error naming the file.
fn parse_port_file(path: &Path, text: &str) -> Result<u16, String> {
    let file: PortFile = serde_json::from_str(text)
        .map_err(|e| format!("the gateway's port file {} is not {{\"port\", \"legacy\"}}: {e}", path.display()))?;
    if file.port == 0 {
        return Err(format!("the gateway's port file {} names port 0", path.display()));
    }
    Ok(file.port)
}

/// What this process knows of the gateway's port.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Port {
    /// The port file names it: the port the gateway listens on.
    Known(u16),
    /// This process was told where the file is, and there is none: the
    /// install has not moved, its gateway is on [`LEGACY_PORT`].
    Unrecorded,
    /// No `EQUIN_GATEWAY_PORT_FILE`: a process the helper's job did not start
    /// (an app window launched from its shim) or a job written before the
    /// variable. Whatever port its URLs carry is the best it knows.
    NotProvided,
}

impl Port {
    /// The port to dial now (the tray, the probes): the known one, else the
    /// legacy one — an install with no port file has not moved.
    pub fn listening(self) -> u16 {
        match self {
            Port::Known(port) => port,
            Port::Unrecorded | Port::NotProvided => LEGACY_PORT,
        }
    }

    /// The port to move a URL onto: only one the port file names. A process
    /// that does not know the port keeps a URL's own (a shim the tray already
    /// rewrote onto the new port must not go back to the legacy one).
    pub fn known(self) -> Option<u16> {
        match self {
            Port::Known(port) => Some(port),
            Port::Unrecorded | Port::NotProvided => None,
        }
    }
}

/// The port named by the file at `path` (`None`: the job names no file).
/// Unreadable or not the file's shape is an error, never a default (a wrong
/// guess would load another account's gateway).
fn port_from(path: Option<&Path>) -> Result<Port, String> {
    let Some(path) = path else { return Ok(Port::NotProvided) };
    match std::fs::read_to_string(path) {
        Ok(text) => parse_port_file(path, &text).map(Port::Known),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Port::Unrecorded),
        Err(e) => Err(format!("cannot read the gateway's port file {}: {e}", path.display())),
    }
}

/// What the port file `EQUIN_GATEWAY_PORT_FILE` names says now. Read at every
/// use: it changes under a running helper.
pub fn port() -> Result<Port, String> {
    let file = std::env::var_os(PORT_FILE_ENV).filter(|f| !f.is_empty());
    port_from(file.as_deref().map(Path::new))
}

/// The port to dial the gateway on now ([`Port::listening`]).
pub fn listening_port() -> Result<u16, String> {
    Ok(port()?.listening())
}

/// Whether something accepts connections on `port`.
pub fn up(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
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
    let mut port = listening_port()?;
    while Instant::now() < deadline {
        if up(port) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
        // A starting gateway may be the one that writes a new port file.
        port = listening_port()?;
    }
    Err(format!(
        "the gateway service started but nothing answers on port {port} after 30 s — see ./equin start"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str, text: Option<&str>) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("equin-desktop-port-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("port");
        let _ = std::fs::remove_file(&path);
        if let Some(text) = text {
            std::fs::write(&path, text).unwrap();
        }
        path
    }

    #[test]
    fn no_file_dials_the_legacy_port_but_moves_nothing() {
        // The job names a file and there is none: the install has not moved.
        let unrecorded = port_from(Some(&scratch("absent", None))).unwrap();
        assert_eq!(unrecorded, Port::Unrecorded);
        assert_eq!(unrecorded.listening(), 9000);
        assert_eq!(unrecorded.known(), None);
        // No variable (an app window launched from its shim): unknown.
        let not_provided = port_from(None).unwrap();
        assert_eq!(not_provided, Port::NotProvided);
        assert_eq!(not_provided.listening(), 9000);
        assert_eq!(not_provided.known(), None);
    }

    #[test]
    fn the_file_names_the_port() {
        let moved = port_from(Some(&scratch("moved", Some(r#"{"port": 8700, "legacy": 9000}"#)))).unwrap();
        assert_eq!(moved, Port::Known(8700));
        assert_eq!(moved.listening(), 8700);
        assert_eq!(moved.known(), Some(8700));
        assert_eq!(port_from(Some(&scratch("fresh", Some(r#"{"port": 8701, "legacy": null}"#)))), Ok(Port::Known(8701)));
    }

    #[test]
    fn a_broken_file_is_an_error_never_a_default() {
        for (name, text) in [
            ("empty", ""),
            ("garbage", "8700"),
            ("no-port", r#"{"legacy": null}"#),
            ("out-of-range", r#"{"port": 70000, "legacy": null}"#),
            ("zero", r#"{"port": 0, "legacy": null}"#),
            ("string", r#"{"port": "8700", "legacy": null}"#),
        ] {
            let err = port_from(Some(&scratch(name, Some(text)))).expect_err(name);
            assert!(err.contains("port file"), "{name}: {err}");
        }
    }
}
