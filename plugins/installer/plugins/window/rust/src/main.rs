//! equin-installer — the installer window.
//!
//! `equin-installer --script <install.sh> [-- <install args…>]` runs the
//! script as its child (child.rs: events on fd 3, decisions on fd 4) and
//! draws the event stream (protocol v1, plugins/installer/core) in a page
//! compiled into the binary, served from `installer://app/` — nothing is
//! fetched from the network.
//!
//! The window keeps every event in memory and sends it to the page; when the
//! page loads (or reloads) it asks for the backlog, so the page is a pure
//! function of the event list. The terminal that started the install gets one
//! plain line per step. Closing the window during the install asks first, then
//! stops it (SIGINT to the install's process group); the process exits with
//! the script's exit code.
//!
//! Design: research/2026-11-17-global-installer-window.md §2.

mod askpass;
mod bootstrap;
mod child;
mod clock;
#[cfg(target_os = "macos")]
mod dock;
mod probe;

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::process::Command;

use serde::Deserialize;
use serde_json::{json, Value};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::http::{header::CONTENT_TYPE, Request, Response};
use wry::WebViewBuilder;

pub(crate) const PAGE: &str = include_str!(concat!(env!("OUT_DIR"), "/page.html"));
pub(crate) const WIDTH: f64 = 760.0;
pub(crate) const HEIGHT: f64 = 640.0;
/// The page's background (`--bg`), painted before the page's first frame.
const BACKGROUND: (u8, u8, u8, u8) = (7, 9, 14, 255);

enum UserEvent {
    /// One line the script wrote on its event fd.
    Event(String),
    /// One line of the script's own stdout / stderr.
    Output { stream: &'static str, line: String },
    /// The script exited (its code, as a shell reports it).
    Exited(i32),
    /// A message from the page.
    Ipc(String),
    /// The page finished loading (shows the window if `ready` has not).
    Loaded,
    /// A signal sent to this process.
    Signal(libc::c_int),
    /// sudo asks for the password (askpass.rs): show the sheet, answer on the stream.
    Password { prompt: String, stream: std::os::unix::net::UnixStream },
}

/// What the page may ask for — a closed set; anything else is refused.
#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "kebab-case")]
enum PageCommand {
    /// The page loaded: send it every event so far.
    Ready,
    /// A paused step: run it again / give up / leave it out (optional only).
    Retry,
    Quit,
    Skip,
    /// Fix with Claude: the Claude app (prompt on the clipboard) or Claude Code in Terminal.
    FixApp,
    FixCli,
    /// Bring Claude back to the front.
    ShowClaude,
    /// Done screen: add what the install went on without (Add it now).
    AddServices,
    /// The user confirmed stopping the install.
    Stop,
    /// Open the installed app in the browser, then close.
    OpenEquin,
    /// Open a link in the browser: a GitHub issue (Report issue), or the
    /// App Management settings — nothing else.
    OpenUrl { url: String },
    /// The password sheet's answer for sudo (askpass.rs).
    Password { value: String },
    PasswordCancel,
    /// Close the window after the install ended.
    Close,
    /// The mouse went down on the page's title-bar strip: move the window.
    Drag,
}

/// The settings pane that allows equin to add its apps (Privacy & Security → App Management).
const APP_MANAGEMENT_URL: &str =
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AppBundles";

/// Whether the page may open `url`: a GitHub link (Report issue opens a new
/// issue there, nothing sent until the user submits it) or App Management.
fn openable(url: &str) -> bool {
    url.starts_with("https://github.com/") || url == APP_MANAGEMENT_URL
}

fn usage() -> ! {
    eprintln!(
        "usage: equin-installer --script <install.sh> [-- <install.sh args…>]\n\
         \x20      equin-installer [--ref <release tag>] [-- <install.sh args…>]   \
         (download and verify the release's install.sh, then run it)\n\
         \x20      equin-installer --probe | --version"
    );
    std::process::exit(2);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut script = None;
    let mut release_ref = None;
    let mut rest = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--version" => {
                println!("equin-installer {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--probe" => probe::run(),
            "--askpass" => askpass::run_client(&args.collect::<Vec<_>>().join(" ")),
            "--script" => script = Some(args.next().unwrap_or_else(|| usage())),
            "--ref" => release_ref = Some(args.next().unwrap_or_else(|| usage())),
            "--" => {
                rest.extend(args.by_ref());
            }
            "-h" | "--help" => usage(),
            other => {
                eprintln!("equin-installer: unknown argument {other:?}");
                usage();
            }
        }
    }
    let script = match (script, release_ref) {
        (Some(_), Some(_)) => {
            eprintln!("equin-installer: --script and --ref exclude each other");
            usage();
        }
        (Some(script), None) => script,
        // Self-bootstrap: no shell around it (the double-click app).
        (None, release_ref) => match bootstrap::fetch(release_ref.as_deref()) {
            Ok(fetched) => {
                let mut handoff = fetched.handoff_args;
                handoff.append(&mut rest);
                rest = handoff;
                fetched.script
            }
            Err(e) => {
                eprintln!("\n{e}\n");
                std::process::exit(1);
            }
        },
    };

    let mut signals = child::catch_signals().unwrap_or_else(|e| {
        eprintln!("equin-installer: could not install its signal handlers: {e}");
        std::process::exit(1);
    });

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // sudo asks for its password through the window (askpass.rs); the
    // install's askpass wrapper finds this binary and the socket by these.
    let (askpass_listener, askpass_path) = askpass::listen().unwrap_or_else(|e| {
        eprintln!("equin-installer: could not open the password socket: {e}");
        std::process::exit(1);
    });
    // Single-threaded still: nothing else reads the environment now.
    std::env::set_var(askpass::SOCKET_ENV, &askpass_path);
    if let Ok(exe) = std::env::current_exe() {
        std::env::set_var(askpass::BIN_ENV, exe);
    }
    ASKPASS_PATH.set(askpass_path).expect("set once");
    let install = child::spawn(&script, &rest).unwrap_or_else(|e| {
        eprintln!("equin-installer: could not start {script}: {e}");
        std::process::exit(1);
    });
    let child_pid = install.child.id();
    println!(
        "\n  Installing in the equin window. Closing it stops the install; \
         running the installer again picks up where it stopped.\n"
    );

    // Readers: each line becomes a user event.
    let events_reader = {
        let (proxy, events) = (proxy.clone(), install.events.try_clone().expect("dup events fd"));
        std::thread::spawn(move || {
            child::for_each_line(events, |line| send(&proxy, UserEvent::Event(line)))
        })
    };
    for (stream, reader) in [
        ("out", Box::new(install.stdout) as Box<dyn std::io::Read + Send>),
        ("err", Box::new(install.stderr)),
    ] {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            child::for_each_line(reader, |line| send(&proxy, UserEvent::Output { stream, line }))
        });
    }
    {
        let proxy = proxy.clone();
        let mut process = install.child;
        let owns_terminal = install.owns_terminal;
        std::thread::spawn(move || {
            let code = match process.wait() {
                Ok(status) => child::exit_code(status),
                Err(e) => {
                    eprintln!("equin-installer: waiting for the install failed: {e}");
                    1
                }
            };
            if owns_terminal {
                child::reclaim_terminal();
            }
            // Every event the script wrote is read before its exit is told.
            let _ = events_reader.join();
            send(&proxy, UserEvent::Exited(code));
        });
    }
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            for stream in askpass_listener.incoming() {
                match stream.and_then(|s| askpass::read_prompt(&s).map(|p| (p, s))) {
                    Ok((prompt, stream)) => send(&proxy, UserEvent::Password { prompt, stream }),
                    Err(e) => eprintln!("equin-installer: a password request failed: {e}"),
                }
            }
        });
    }
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || loop {
            match child::wait_signal(&mut signals) {
                Ok(sig) => send(&proxy, UserEvent::Signal(sig)),
                Err(e) => {
                    eprintln!("equin-installer: the signal pipe failed: {e}");
                    return;
                }
            }
        });
    }

    // The Dock shows equin's icon, not a bare executable's.
    #[cfg(target_os = "macos")]
    dock::set_icon();

    // Hidden until the page has drawn (its `ready`): a webview paints white
    // until its first frame, which on a cold Mac takes seconds.
    let (r, g, b, a) = BACKGROUND;
    let mut builder = WindowBuilder::new()
        .with_title("equin installer")
        .with_inner_size(LogicalSize::new(WIDTH, HEIGHT))
        .with_resizable(false)
        .with_visible(false)
        .with_background_color((r, g, b, a));
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::WindowBuilderExtMacOS;
        builder = builder
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true);
    }
    let window = builder.build(&event_loop).unwrap_or_else(|e| {
        eprintln!("equin-installer: could not open the window: {e}");
        child::signal_group(child_pid, libc::SIGINT);
        std::process::exit(1);
    });

    let ipc_proxy = proxy.clone();
    let load_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_background_color(BACKGROUND)
        .with_devtools(cfg!(debug_assertions))
        .with_custom_protocol("installer".into(), |_id, request| serve_page(&request))
        .with_ipc_handler(move |request: Request<String>| {
            send(&ipc_proxy, UserEvent::Ipc(request.into_body()))
        })
        // The backstop for `ready`: a page that loaded but never said ready
        // (its script threw) is still shown, broken, never left invisible.
        .with_on_page_load_handler(move |load, _url| {
            if matches!(load, wry::PageLoadEvent::Finished) {
                send(&load_proxy, UserEvent::Loaded);
            }
        })
        .with_url("installer://app/");
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        webview.build_gtk(window.default_vbox().expect("tao's gtk window has a vbox"))
    };
    #[cfg(not(target_os = "linux"))]
    let webview = webview.build(&window);
    let webview = webview.unwrap_or_else(|e| {
        eprintln!("equin-installer: could not open the page: {e}");
        child::signal_group(child_pid, libc::SIGINT);
        std::process::exit(1);
    });

    let mut state = State {
        backlog: Vec::new(),
        sent: 0,
        page_ready: false,
        shown: false,
        labels: HashMap::new(),
        with_subs: HashSet::new(),
        done_url: None,
        saw_exit: false,
        exit_code: None,
        stopping: false,
        control: Some(install.control),
        password: None,
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Event(line)) => {
                if state.event(line) == After::Forward {
                    bring_forward(&window);
                }
            }
            Event::UserEvent(UserEvent::Output { stream, line }) => {
                let event = json!({
                    "v": 1, "t": clock::now_iso(), "type": "log",
                    "step": null, "stream": stream, "line": line,
                });
                state.backlog.push(event.to_string());
            }
            Event::UserEvent(UserEvent::Exited(code)) => {
                state.exit_code = Some(code);
                if !state.saw_exit {
                    // Killed before its EXIT trap could say so.
                    let event = json!({ "v": 1, "t": clock::now_iso(), "type": "exit", "code": code });
                    state.backlog.push(event.to_string());
                }
                // Stopped (the window's Stop, Ctrl-C in the terminal): done here too.
                if state.stopping || code == 128 + libc::SIGINT {
                    finish(code);
                }
            }
            Event::UserEvent(UserEvent::Loaded) => show(&window, &mut state.shown),
            Event::UserEvent(UserEvent::Signal(sig)) => {
                state.stopping = true;
                match state.exit_code {
                    Some(code) => finish(code),
                    None => child::signal_group(child_pid, if sig == libc::SIGHUP { libc::SIGHUP } else { libc::SIGINT }),
                }
            }
            Event::UserEvent(UserEvent::Password { prompt, stream }) => {
                if let Some((_, old)) = state.password.take() {
                    let _ = askpass::answer(old, None);
                }
                ask_password(&webview, &prompt);
                state.password = Some((prompt, stream));
            }
            Event::UserEvent(UserEvent::Ipc(body)) => match serde_json::from_str::<PageCommand>(&body) {
                Ok(PageCommand::Ready) => {
                    show(&window, &mut state.shown);
                    state.page_ready = true;
                    state.sent = 0;
                    if let Some((prompt, _)) = &state.password {
                        ask_password(&webview, prompt);
                    }
                }
                Ok(PageCommand::Retry) => state.decide("retry"),
                Ok(PageCommand::Quit) => state.decide("quit"),
                Ok(PageCommand::Skip) => state.decide("skip"),
                Ok(PageCommand::FixApp) => state.decide("fix-app"),
                Ok(PageCommand::FixCli) => state.decide("fix-cli"),
                Ok(PageCommand::ShowClaude) => state.decide("show-claude"),
                Ok(PageCommand::AddServices) => state.decide("add-services"),
                Ok(PageCommand::OpenUrl { url }) => {
                    if openable(&url) {
                        open_url(&url);
                    } else {
                        eprintln!("equin-installer: refused to open a link the page may not open: {url}");
                    }
                }
                Ok(PageCommand::Password { value }) => match state.password.take() {
                    Some((_, stream)) => {
                        if let Err(e) = askpass::answer(stream, Some(&value)) {
                            eprintln!("equin-installer: could not hand the password to sudo: {e}");
                        }
                    }
                    None => eprintln!("equin-installer: a password came with no request waiting; dropped"),
                },
                Ok(PageCommand::PasswordCancel) => {
                    if let Some((_, stream)) = state.password.take() {
                        let _ = askpass::answer(stream, None);
                    }
                }
                Ok(PageCommand::Stop) => {
                    state.stopping = true;
                    match state.exit_code {
                        Some(code) => finish(code),
                        None => child::signal_group(child_pid, libc::SIGINT),
                    }
                }
                Ok(PageCommand::OpenEquin) => {
                    if let Some(url) = &state.done_url {
                        open_url(url);
                    }
                    state.close_done();
                }
                Ok(PageCommand::Drag) => {
                    if let Err(e) = window.drag_window() {
                        eprintln!("equin-installer: could not move the window: {e}");
                    }
                }
                Ok(PageCommand::Close) => match state.exit_code {
                    Some(code) => finish(code),
                    None if state.done_url.is_some() => state.close_done(),
                    None => eprintln!("equin-installer: the page asked to close while the install runs; ignored"),
                },
                Err(e) => eprintln!("equin-installer: refused a message from the page ({e}): {body}"),
            },
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => match state.exit_code {
                Some(code) => finish(code),
                // Installed; the script only waits on Add it now.
                None if state.done_url.is_some() => state.close_done(),
                None => {
                    if let Err(e) = webview.evaluate_script("window.installer.confirmStop()") {
                        eprintln!("equin-installer: could not ask the page to confirm: {e}");
                    }
                }
            },
            Event::MainEventsCleared => {
                if state.page_ready && state.sent < state.backlog.len() {
                    let batch = &state.backlog[state.sent..];
                    let js = format!(
                        "window.installer.push({})",
                        serde_json::to_string(batch).expect("strings serialize")
                    );
                    match webview.evaluate_script(&js) {
                        Ok(()) => state.sent = state.backlog.len(),
                        Err(e) => eprintln!("equin-installer: could not send events to the page: {e}"),
                    }
                }
            }
            _ => {}
        }
    });
}

struct State {
    /// Every protocol line so far, in order (raw JSON; the page parses it).
    backlog: Vec<String>,
    /// How many of them the page has.
    sent: usize,
    page_ready: bool,
    /// The window is on screen (it opens hidden until the page has drawn).
    shown: bool,
    /// Step labels from the plan, for the terminal's lines.
    labels: HashMap<String, String>,
    /// The steps that have sub-steps (their terminal line is a heading).
    with_subs: HashSet<String>,
    /// The `done` event's URL — the only URL Open equin opens.
    done_url: Option<String>,
    saw_exit: bool,
    exit_code: Option<i32>,
    stopping: bool,
    control: Option<std::fs::File>,
    /// sudo's open password request: its prompt and where the answer goes.
    password: Option<(String, std::os::unix::net::UnixStream)>,
}

impl State {
    fn event(&mut self, line: String) -> After {
        let after = match serde_json::from_str::<Value>(&line) {
            Ok(event) => {
                self.terminal_line(&event);
                after(&event)
            }
            // Not ours to judge: the page parses every line against the
            // schema and shows a protocol error loudly.
            Err(e) => {
                eprintln!("equin-installer: the install wrote a line that is not JSON ({e})");
                After::Nothing
            }
        };
        self.backlog.push(line);
        after
    }

    /// One plain line per step on the terminal that started the install,
    /// written when the step ends (never a "started" line too).
    fn terminal_line(&mut self, event: &Value) {
        let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match event.get("type").and_then(Value::as_str) {
            Some("plan") => {
                // A step's sub-steps (`build.deps`, …) are reported on their
                // own: their labels too, so their lines read as words.
                for step in event.get("steps").and_then(Value::as_array).into_iter().flatten() {
                    self.labels.insert(text(step, "id"), text(step, "label"));
                    let subs = step.get("substeps").and_then(Value::as_array);
                    if subs.is_some_and(|s| !s.is_empty()) {
                        self.with_subs.insert(text(step, "id"));
                    }
                    for sub in subs.into_iter().flatten() {
                        self.labels.insert(text(sub, "id"), text(sub, "label"));
                    }
                }
            }
            Some("step") => {
                let id = text(event, "id");
                // A sub-step's id is `<step>.<sub>`: its line is indented under its step's.
                let sub = id.contains('.');
                let indent = if sub { "    " } else { "  " };
                // A skipped step was done by an earlier run; a skipped sub-step had nothing to do.
                let skipped = if sub { "nothing to do" } else { "already done" };
                let label = self.labels.get(&id).cloned().unwrap_or_else(|| id.clone());
                // One line per step, once it has ended: the window shows what
                // runs now. A step with sub-steps is their heading instead:
                // its name when it starts, their ✓ lines under it.
                let headed = self.with_subs.contains(&id);
                let line = match text(event, "state").as_str() {
                    "start" if headed => format!("{indent}{label}"),
                    "done" if headed => return,
                    "done" => format!("{indent}✓ {label}"),
                    "skipped" => format!("{indent}✓ {label} ({skipped})"),
                    "failed" => format!("{indent}✗ {label}: stopped; see the window"),
                    _ => return,
                };
                println!("{line}");
            }
            Some("pause") => {
                let title = text(event, "title");
                if event.get("blocking").and_then(Value::as_bool) == Some(true) {
                    println!("  ! Paused: {title}. The window says what to do.");
                } else {
                    println!("  ! {title}. The install keeps going; the window says more.");
                }
            }
            Some("done") => {
                let url = text(event, "url");
                println!("\n  equin is running: {url}\n");
                self.done_url = Some(url);
            }
            Some("exit") => self.saw_exit = true,
            _ => {}
        }
        let _ = std::io::stdout().flush();
    }

    /// The install is done and the window closes: the script, still waiting
    /// on Add it now, is told to end (quit), and the window exits 0.
    fn close_done(&mut self) -> ! {
        self.decide("quit");
        finish(self.exit_code.unwrap_or(0));
    }

    fn decide(&mut self, decision: &str) {
        let Some(control) = self.control.as_mut() else { return };
        if let Err(e) = child::decide(control, decision) {
            eprintln!("equin-installer: could not send '{decision}' to the install: {e}");
            self.control = None;
        }
    }
}

/// The page, served from `installer://app/`; nothing else exists.
pub(crate) fn serve_page(request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    if request.uri().path() == "/" {
        Response::builder()
            .header(CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Cow::Borrowed(PAGE.as_bytes()))
            .expect("a static response")
    } else {
        Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b"not found"[..]))
            .expect("a static response")
    }
}

/// What the window itself does on an event, beyond drawing it.
#[derive(PartialEq)]
enum After {
    Nothing,
    /// Apple's developer-tools installer is done (its wait ended): its
    /// dialog — brought in front of the window so the user could click
    /// Install — now says "The software was installed" and stays there
    /// until clicked, over the steps and progress. Come back above it.
    Forward,
}

fn after(event: &Value) -> After {
    let field = |k: &str| event.get(k).and_then(Value::as_str);
    if field("type") == Some("wait") && field("on") == Some("apple-installer") && field("state") == Some("end") {
        After::Forward
    } else {
        After::Nothing
    }
}

/// Bring the window back in front of another app's window. `set_focus`
/// activates the app, which macOS 14+ may refuse to an app in the background
/// (cooperative activation); `orderFrontRegardless` puts the window above
/// the others whether or not the app becomes active. Apple's dialog stays
/// open behind it, for the user to dismiss — never clicked for them.
fn bring_forward(window: &tao::window::Window) {
    window.set_focus();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::WindowExtMacOS;
        // SAFETY: tao's ns_window is the live NSWindow it owns for as long
        // as `window` lives, and this runs on the main thread (the event loop).
        let ns_window = unsafe { &*(window.ns_window() as *const objc2_app_kit::NSWindow) };
        ns_window.orderFrontRegardless();
    }
}

/// Put the window on screen, once.
fn show(window: &tao::window::Window, shown: &mut bool) {
    if *shown {
        return;
    }
    *shown = true;
    window.set_visible(true);
    window.set_focus();
}

fn send(proxy: &EventLoopProxy<UserEvent>, event: UserEvent) {
    // Fails only once the event loop has exited, when nothing is listening.
    let _ = proxy.send_event(event);
}

fn open_url(url: &str) {
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    if let Err(e) = Command::new(opener).arg(url).status() {
        eprintln!("equin-installer: could not open {url} with {opener}: {e}");
    }
}

/// The password socket, removed on the way out.
static ASKPASS_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Show the page's password sheet.
fn ask_password(webview: &wry::WebView, prompt: &str) {
    let js = format!(
        "window.installer.askPassword({})",
        serde_json::to_string(prompt).expect("a string serializes")
    );
    if let Err(e) = webview.evaluate_script(&js) {
        eprintln!("equin-installer: could not ask the page for the password: {e}");
    }
}

/// Exit with the install's code.
fn finish(code: i32) -> ! {
    if let Some(path) = ASKPASS_PATH.get() {
        askpass::remove(path);
    }
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}
