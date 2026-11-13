//! One process per installed app: the first window-mode process for an app
//! listens on a per-user Unix socket named after it; a later launch connects,
//! hands over its URL (one line, empty = just come forward) and exits. The
//! running window raises itself and navigates there when it is in its scope.
//!
//! macOS LaunchServices already keeps one process per bundle id for Dock /
//! Finder / `open` launches; the socket covers the rest (a direct exec, every
//! Linux launch) and carries the URL a running app cannot otherwise be given.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

use url::Url;

fn socket_path(app_id: &str) -> PathBuf {
    // Per-user directories: macOS $TMPDIR, Linux $XDG_RUNTIME_DIR.
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|d| cfg!(target_os = "linux") && !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    dir.join(format!("equin-app-{app_id}.sock"))
}

/// Hand `url` to the app's running instance. `false` when none is running.
pub fn forward(app_id: &str, url: Option<&Url>) -> bool {
    let Ok(mut stream) = UnixStream::connect(socket_path(app_id)) else { return false };
    let line = url.map(Url::as_str).unwrap_or("");
    match writeln!(stream, "{line}") {
        Ok(()) => true,
        Err(e) => {
            eprintln!("equin-desktop: the running {app_id} window did not take the hand-off: {e}");
            false
        }
    }
}

pub enum Claim {
    /// Another process is the app's instance and took the URL: exit.
    Forwarded,
    /// This process is the instance; `None` when the socket could not be
    /// bound (it runs anyway — a later launch then opens a second window
    /// instead of focusing this one: visible, not fatal).
    Owner(Option<UnixListener>),
}

/// Become the app's one instance, or hand `url` (none: just come forward) to
/// the one that is.
pub fn claim(app_id: &str, url: Option<&Url>) -> Claim {
    if forward(app_id, url) {
        return Claim::Forwarded;
    }
    let path = socket_path(app_id);
    // Nothing answered: a socket file left here is a dead instance's.
    if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            eprintln!("equin-desktop: cannot remove the stale {}: {e}", path.display());
        }
    }
    match UnixListener::bind(&path) {
        Ok(listener) => Claim::Owner(Some(listener)),
        Err(e) => {
            eprintln!("equin-desktop: cannot listen on {} ({e}); single-instance is off", path.display());
            Claim::Owner(None)
        }
    }
}

/// Serve hand-offs on a thread: each one is `on_handoff(Some(url) | None)`.
pub fn serve(listener: UnixListener, on_handoff: impl Fn(Option<Url>) + Send + 'static) {
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let mut line = String::new();
            if BufReader::new(stream).read_line(&mut line).is_err() {
                continue;
            }
            let line = line.trim();
            on_handoff(if line.is_empty() { None } else { Url::parse(line).ok() });
        }
    });
}

/// Remove this instance's socket on exit, so the next launch binds cleanly.
pub fn release(app_id: &str) {
    let _ = std::fs::remove_file(socket_path(app_id));
}
