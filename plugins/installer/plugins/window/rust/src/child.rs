//! The install script as this window's child.
//!
//! - **Events on fd 3, decisions on fd 4.** Two pipes, moved onto the child's
//!   fds 3 and 4 just before exec (`--events-fd 3 --control-fd 4`); every
//!   other end is close-on-exec, so nothing else inherits them.
//! - **Its own process group, in the terminal's foreground.** Stopping the
//!   install signals the whole group (bash and the step it is running), and
//!   while the install runs it IS the terminal's foreground job: `sudo` can
//!   read a password from the terminal (a background job reading it would be
//!   stopped by SIGTTIN), and Ctrl-C in the terminal reaches the install
//!   directly. When the child exits, the terminal is handed back to us.
//! - **Signals sent to the window** (SIGINT, SIGTERM, SIGHUP) run a handler
//!   that writes the signal's number to a pipe ([`catch_signals`]); one thread
//!   reads it and hands it to the event loop. A disposition is process-wide,
//!   so it holds whichever thread the kernel delivers to — a blocked mask
//!   would not: macOS starts its dispatch worker threads without it, and a
//!   SIGTERM landing on one killed the window and left the install running.
//!   SIGTTOU is ignored, so the window may take the terminal back while in the
//!   background. The child starts with every one of them at its default.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, ChildStderr, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};

/// The signals the window turns into events.
const CAUGHT: [libc::c_int; 3] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP];
/// Reset to the default in the child (an ignored one survives exec).
const CHILD_DEFAULTS: [libc::c_int; 5] =
    [libc::SIGINT, libc::SIGQUIT, libc::SIGTERM, libc::SIGHUP, libc::SIGTTOU];

/// The write end of the signal pipe, for the handler.
static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(sig: libc::c_int) {
    let fd = SIGNAL_PIPE.load(Ordering::Relaxed);
    let byte = sig as u8;
    // SAFETY: write(2) is async-signal-safe; a full pipe drops the byte, and
    // the reader acts on the first one anyway.
    unsafe { libc::write(fd, (&byte as *const u8).cast(), 1) };
}

/// Install the handlers; the returned pipe yields one byte per signal.
pub fn catch_signals() -> io::Result<File> {
    let (read, write) = pipe()?;
    // SAFETY: fcntl on our own fd; non-blocking so the handler never waits.
    unsafe { libc::fcntl(write.as_raw_fd(), libc::F_SETFL, libc::O_NONBLOCK) };
    SIGNAL_PIPE.store(write.as_raw_fd(), Ordering::Relaxed);
    std::mem::forget(write); // the handler's for the life of the process
    for sig in CAUGHT {
        // SAFETY: a valid handler; SA_RESTART so reads elsewhere are not cut.
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as usize;
            action.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut action.sa_mask);
            if libc::sigaction(sig, &action, std::ptr::null_mut()) != 0 {
                return Err(io::Error::last_os_error());
            }
        }
    }
    // SAFETY: ignoring SIGTTOU only lets tcsetpgrp succeed from the background.
    unsafe { libc::signal(libc::SIGTTOU, libc::SIG_IGN) };
    Ok(File::from(read))
}

/// Wait for the next caught signal.
pub fn wait_signal(pipe: &mut File) -> io::Result<libc::c_int> {
    let mut byte = [0u8; 1];
    pipe.read_exact(&mut byte)?;
    Ok(libc::c_int::from(byte[0]))
}

/// A pipe whose two ends are close-on-exec and numbered above 10, so moving
/// one onto fd 3 or 4 in the child can never overwrite the other.
fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: fds is a valid out-array of two.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut moved = [0 as RawFd; 2];
    for (i, fd) in fds.into_iter().enumerate() {
        // SAFETY: fd is open; F_DUPFD_CLOEXEC returns a new fd >= 10.
        let high = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 10) };
        // SAFETY: fd is ours to close.
        unsafe { libc::close(fd) };
        if high < 0 {
            return Err(io::Error::last_os_error());
        }
        moved[i] = high;
    }
    // SAFETY: both fds are freshly created and owned by nothing else.
    Ok(unsafe { (OwnedFd::from_raw_fd(moved[0]), OwnedFd::from_raw_fd(moved[1])) })
}

/// Keep fds 3 and 4 taken in this process (by /dev/null, close-on-exec) when
/// they are free. `Command::spawn` reports an exec failure through a pipe of
/// its own, created at the lowest free fds: were that 3 or 4, the child's
/// dup2 onto them would close it, and a failed exec would read as a spawn
/// that worked.
fn hold_low_fds() -> io::Result<()> {
    for fd in [3, 4] {
        // SAFETY: F_GETFD only reads the fd's flags.
        if unsafe { libc::fcntl(fd, libc::F_GETFD) } != -1 {
            continue;
        }
        // SAFETY: a static path; the result is checked.
        let null = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
        if null < 0 {
            return Err(io::Error::last_os_error());
        }
        if null != fd {
            // SAFETY: both fds are ours; dup2 clears close-on-exec, so set it again.
            unsafe {
                libc::dup2(null, fd);
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                libc::close(null);
            }
        }
    }
    Ok(())
}

/// The running install.
pub struct Install {
    pub child: Child,
    /// The event stream (the child's fd 3).
    pub events: File,
    /// The decision pipe (the child's fd 4).
    pub control: File,
    pub stdout: ChildStdout,
    pub stderr: ChildStderr,
    /// Whether the child was made the terminal's foreground job.
    pub owns_terminal: bool,
}

/// Start `bash <script> --events-fd 3 --control-fd 4 <args…>`.
pub fn spawn(script: &str, args: &[String]) -> io::Result<Install> {
    hold_low_fds()?;
    let (events_r, events_w) = pipe()?;
    let (control_r, control_w) = pipe()?;
    let (ev_w, ctl_r) = (events_w.as_raw_fd(), control_r.as_raw_fd());
    // SAFETY: isatty / tcgetpgrp / getpgrp only read.
    let owns_terminal =
        unsafe { libc::isatty(0) == 1 && libc::tcgetpgrp(0) == libc::getpgrp() };

    let mut cmd = Command::new("bash");
    cmd.arg(script)
        .args(["--events-fd", "3", "--control-fd", "4"])
        .args(args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: only async-signal-safe calls (dup2, setpgid, tcsetpgrp,
    // signal) between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(ev_w, 3) < 0 || libc::dup2(ctl_r, 4) < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            // SIGTTOU is still ignored here (inherited): a background group
            // may take the terminal.
            if owns_terminal && libc::tcsetpgrp(0, libc::getpid()) != 0 {
                return Err(io::Error::last_os_error());
            }
            // An ignored signal stays ignored across exec, and a window
            // started in the background by a non-interactive shell (`… &`)
            // has SIGINT ignored: the install would then survive Stop and
            // Ctrl-C. It starts with the defaults, always.
            for sig in CHILD_DEFAULTS {
                libc::signal(sig, libc::SIG_DFL);
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    // The child's ends: closed here, so EOF on the event pipe means every
    // writer is gone.
    drop(events_w);
    drop(control_r);
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    Ok(Install {
        child,
        events: File::from(events_r),
        control: File::from(control_w),
        stdout,
        stderr,
        owns_terminal,
    })
}

/// Give the terminal back to this process's group (after the child exited).
pub fn reclaim_terminal() {
    // SAFETY: SIGTTOU is ignored (catch_signals), so a background process
    // may set the foreground group.
    unsafe {
        libc::tcsetpgrp(0, libc::getpgrp());
    }
}

/// Send `sig` to the install's whole process group.
pub fn signal_group(pid: u32, sig: libc::c_int) {
    // SAFETY: kill only signals; the group exists until the child is reaped.
    unsafe {
        libc::kill(-(pid as libc::pid_t), sig);
    }
}

/// Write one decision line to the child's control fd.
pub fn decide(control: &mut File, decision: &str) -> io::Result<()> {
    control.write_all(format!("{decision}\n").as_bytes())
}

/// Every line of `reader`, decoded lossily, handed to `each` until EOF.
pub fn for_each_line(reader: impl io::Read, mut each: impl FnMut(String)) {
    for line in BufReader::new(reader).split(b'\n') {
        match line {
            Ok(bytes) => each(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) => {
                eprintln!("equin-installer: reading the install's output failed: {e}");
                return;
            }
        }
    }
}

/// The child's exit code as a shell reports it (128 + signal when killed).
pub fn exit_code(status: std::process::ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}
