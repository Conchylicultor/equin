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

mod bootstrap;
mod child;
mod clock;
mod probe;

use std::borrow::Cow;
use std::collections::HashMap;
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
    /// A signal sent to this process.
    Signal(libc::c_int),
}

/// What the page may ask for — a closed set; anything else is refused.
#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "kebab-case")]
enum PageCommand {
    /// The page loaded: send it every event so far.
    Ready,
    /// A failed step: run it again / give up.
    Retry,
    Quit,
    /// The user confirmed stopping the install.
    Stop,
    /// Open the installed app in the browser, then close.
    OpenEquin,
    /// Close the window after the install ended.
    Close,
    /// The mouse went down on the page's title-bar strip: move the window.
    Drag,
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

    let mut builder = WindowBuilder::new()
        .with_title("equin installer")
        .with_inner_size(LogicalSize::new(WIDTH, HEIGHT))
        .with_resizable(false);
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
    let webview = WebViewBuilder::new()
        .with_background_color(BACKGROUND)
        .with_devtools(cfg!(debug_assertions))
        .with_custom_protocol("installer".into(), |_id, request| serve_page(&request))
        .with_ipc_handler(move |request: Request<String>| {
            send(&ipc_proxy, UserEvent::Ipc(request.into_body()))
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
    window.set_focus();

    let mut state = State {
        backlog: Vec::new(),
        sent: 0,
        page_ready: false,
        labels: HashMap::new(),
        done_url: None,
        saw_exit: false,
        exit_code: None,
        stopping: false,
        control: Some(install.control),
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Event(line)) => state.event(line),
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
            Event::UserEvent(UserEvent::Signal(sig)) => {
                state.stopping = true;
                match state.exit_code {
                    Some(code) => finish(code),
                    None => child::signal_group(child_pid, if sig == libc::SIGHUP { libc::SIGHUP } else { libc::SIGINT }),
                }
            }
            Event::UserEvent(UserEvent::Ipc(body)) => match serde_json::from_str::<PageCommand>(&body) {
                Ok(PageCommand::Ready) => {
                    state.page_ready = true;
                    state.sent = 0;
                }
                Ok(PageCommand::Retry) => state.decide("retry"),
                Ok(PageCommand::Quit) => state.decide("quit"),
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
                    finish(state.exit_code.unwrap_or(0));
                }
                Ok(PageCommand::Drag) => {
                    if let Err(e) = window.drag_window() {
                        eprintln!("equin-installer: could not move the window: {e}");
                    }
                }
                Ok(PageCommand::Close) => match state.exit_code {
                    Some(code) => finish(code),
                    None => eprintln!("equin-installer: the page asked to close while the install runs; ignored"),
                },
                Err(e) => eprintln!("equin-installer: refused a message from the page ({e}): {body}"),
            },
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => match state.exit_code {
                Some(code) => finish(code),
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
    /// Step labels from the plan, for the terminal's lines.
    labels: HashMap<String, String>,
    /// The `done` event's URL — the only URL Open equin opens.
    done_url: Option<String>,
    saw_exit: bool,
    exit_code: Option<i32>,
    stopping: bool,
    control: Option<std::fs::File>,
}

impl State {
    fn event(&mut self, line: String) {
        match serde_json::from_str::<Value>(&line) {
            Ok(event) => self.terminal_line(&event),
            // Not ours to judge: the page parses every line against the
            // schema and shows a protocol error loudly.
            Err(e) => eprintln!("equin-installer: the install wrote a line that is not JSON ({e})"),
        }
        self.backlog.push(line);
    }

    /// One plain line per step on the terminal that started the install.
    fn terminal_line(&mut self, event: &Value) {
        let text = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        match event.get("type").and_then(Value::as_str) {
            Some("plan") => {
                // A step's sub-steps (`build.deps`, …) are reported on their
                // own: their labels too, so their lines read as words.
                for step in event.get("steps").and_then(Value::as_array).into_iter().flatten() {
                    self.labels.insert(text(step, "id"), text(step, "label"));
                    for sub in step.get("substeps").and_then(Value::as_array).into_iter().flatten() {
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
                let label = self.labels.get(&id).cloned().unwrap_or(id);
                let line = match text(event, "state").as_str() {
                    "start" => format!("{indent}… {label}"),
                    "done" => format!("{indent}✓ {label}"),
                    "skipped" => format!("{indent}✓ {label} ({skipped})"),
                    "failed" => format!("{indent}✗ {label}: stopped; see the window"),
                    _ => return,
                };
                println!("{line}");
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

/// Exit with the install's code.
fn finish(code: i32) -> ! {
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}
