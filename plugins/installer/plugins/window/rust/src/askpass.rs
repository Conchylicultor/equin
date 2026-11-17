//! sudo's password, asked in the window (Linux: apt and enable-linger need
//! sudo; macOS uses Apple's own dialog and never gets here).
//!
//! install.sh runs `sudo -A` with SUDO_ASKPASS set to a two-line wrapper that
//! execs this binary as `equin-installer --askpass <prompt>`. That process is
//! a grandchild of the window, with no window of its own: it connects to the
//! window's socket (its path in [`SOCKET_ENV`], set for the install), sends
//! the prompt as one line and waits for one line back — `ok <password>` or
//! `cancel`. The window shows a password sheet for it; the password goes to
//! sudo's pipe only, never to a file or the event stream.

use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;

/// The socket's path, for the askpass process.
pub const SOCKET_ENV: &str = "EQUIN_INSTALLER_ASKPASS";
/// This binary's path, for install.sh's askpass wrapper.
pub const BIN_ENV: &str = "EQUIN_INSTALLER_BIN";

/// A listening socket in a directory only this user can enter.
pub fn listen() -> io::Result<(UnixListener, PathBuf)> {
    let dir = std::env::temp_dir().join(format!("equin-installer-{}", std::process::id()));
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    let path = dir.join("askpass.sock");
    Ok((UnixListener::bind(&path)?, path))
}

/// Remove the socket and its directory (the window is closing).
pub fn remove(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir(dir);
    }
}

/// One request: its prompt, read from the connection.
pub fn read_prompt(stream: &UnixStream) -> io::Result<String> {
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line)?;
    Ok(line.trim_end_matches('\n').to_string())
}

/// Answer a request: the password, or None for cancelled.
pub fn answer(mut stream: UnixStream, password: Option<&str>) -> io::Result<()> {
    let reply = match password {
        Some(p) => format!("ok {}\n", p.replace('\n', "")),
        None => "cancel\n".to_string(),
    };
    stream.write_all(reply.as_bytes())
}

/// `--askpass <prompt>`: ask the window, print the password for sudo.
pub fn run_client(prompt: &str) -> ! {
    let code = match ask(prompt) {
        Ok(Some(password)) => {
            println!("{password}");
            0
        }
        Ok(None) => 1,
        Err(e) => {
            eprintln!("equin-installer --askpass: could not ask the installer window: {e}");
            1
        }
    };
    std::process::exit(code);
}

fn ask(prompt: &str) -> io::Result<Option<String>> {
    let path = std::env::var_os(SOCKET_ENV)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{SOCKET_ENV} is not set")))?;
    let mut stream = UnixStream::connect(path)?;
    stream.write_all(format!("{}\n", prompt.replace('\n', " ")).as_bytes())?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line)?;
    let line = line.trim_end_matches('\n');
    Ok(line.strip_prefix("ok ").map(str::to_string))
}
