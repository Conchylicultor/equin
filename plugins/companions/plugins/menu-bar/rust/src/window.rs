//! Window mode: one installed app's own process — a regular app with its own
//! Dock icon (macOS: the shim bundle's identity) or window class (Linux:
//! `equin-<id>`, the shim's `StartupWMClass`), and its windows, each on a page
//! of the app as the app's own document (never `?embed=`, see
//! `shim::window_url`). The first is `app`; every hand-off carrying a page
//! opens another (`app-2`, `app-3`, …) — unless a window already shows that
//! very page, which comes forward instead — so opening a page never replaces
//! what another window shows. A hand-off with no page (the Dock, the menu
//! bar's launch) brings the last focused window forward.
//!
//! Its one bridge, `window.equinWindow` (src/window_bridge.js), carries the
//! powers a page of the app needs from this machine — today a native file
//! drag (src/file_drag.rs). It is held to the window's origin (`Scope`): the
//! ACL grants its commands to window `app` on that origin only, the script
//! defines it only there and in the main frame, and every command checks the
//! page the window shows when it is called (src/commands.rs). The origin is
//! the owner's instance, whose pages already read and serve any host file —
//! the bridge hands them no new reach. The window takes no other script.
//!
//! Drops reach the page: Tauri's own drop handler is off, so the page's HTML
//! drag and drop runs as in a browser (its own row drags, and files dropped
//! from Finder) — with it on, every drag over the window was Tauri's.
//!
//! It keeps to its namespace (`window_scope`: the app URL's whole origin, not
//! its base path), so the app's own ways to other apps — the launcher, a link
//! into another app — stay in this window. The holder decides, before the
//! fact: a main-frame load off the origin (a link, a form, `location.*`, a
//! server redirect) is cancelled natively before it loads (`src/main_frame.rs`)
//! and handed to the installed app owning the URL, else the default browser
//! (`shim::hand_off`); every `window.open` / `target=_blank` is handed off
//! the same way — one of its own app's pages comes back as a hand-off, so it
//! opens in a new window of this process. Frames are untouched: an app
//! frames content origins and foreign sites. Hand-offs go through one burst
//! gate (`scope_gate::hand_off`), so a page cannot flood the browser.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

use crate::command_table::APP_WINDOW_COMMANDS;
use crate::main_frame::{self, FrameKind};
use crate::scope_gate::{self, admits_main_frame, web};
use crate::{instance, shim};

/// The first window's label; the next ones are `app-2`, `app-3`, ….
pub const LABEL: &str = "app";
const BRIDGE_JS: &str = include_str!("window_bridge.js");
const DEFAULT_SIZE: (f64, f64) = (1200.0, 800.0);
/// How far a new window sits below and right of the one it opened from.
const CASCADE: f64 = 28.0;

/// Whether `label` is one of the app's windows.
pub fn is_app_label(label: &str) -> bool {
    label == LABEL
        || label
            .strip_prefix(LABEL)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// What a window-mode process opens.
#[derive(Debug, PartialEq, Clone)]
pub struct Launch {
    pub app_id: String,
    /// The window title (the shim's name).
    pub name: String,
    /// The app's URL: where the window opens; its origin is the window's scope.
    pub base: Url,
    /// Where to open — `base` or a URL inside it.
    pub url: Url,
}

/// The remembered window frame, per app (logical px).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn frame_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

fn load_frame(app: &AppHandle) -> Option<Frame> {
    let frame: Frame = serde_json::from_str(&std::fs::read_to_string(frame_file(app)?).ok()?).ok()?;
    if !(frame.width >= 320.0 && frame.height >= 240.0) {
        return None;
    }
    // Only where a monitor still is (a display may have gone since).
    let on_screen = app.available_monitors().ok()?.iter().any(|m| {
        let scale = m.scale_factor();
        let p = m.position().to_logical::<f64>(scale);
        let s = m.size().to_logical::<f64>(scale);
        frame.x >= p.x - 50.0 && frame.x < p.x + s.width - 50.0 && frame.y >= p.y - 50.0 && frame.y < p.y + s.height - 50.0
    });
    on_screen.then_some(frame)
}

fn frame_of(window: &WebviewWindow) -> Option<Frame> {
    let (Ok(scale), Ok(pos), Ok(size)) = (window.scale_factor(), window.outer_position(), window.inner_size()) else {
        return None;
    };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    Some(Frame { x: pos.x, y: pos.y, width: size.width, height: size.height })
}

/// A new window's frame: the one it opened from, moved down and right.
fn cascade(from: Frame) -> Frame {
    Frame { x: from.x + CASCADE, y: from.y + CASCADE, ..from }
}

fn save_frame(window: &WebviewWindow) {
    let Some(frame) = frame_of(window) else { return };
    let Some(file) = frame_file(window.app_handle()) else { return };
    let written = file
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::write(&file, serde_json::to_string(&frame).expect("a frame serializes")));
    if let Err(e) = written {
        eprintln!("equin-desktop: cannot remember the window frame in {}: {e}", file.display());
    }
}

fn focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// What the window may show: every page of the app URL's namespace (its
/// origin), so moving to another app of it keeps this window.
fn window_scope(base: &Url) -> Url {
    let mut scope = base.clone();
    scope.set_path("/");
    scope.set_query(None);
    scope.set_fragment(None);
    scope
}

/// What the window's bridge answers: the pages of the app URL's origin.
pub struct Scope(Url);

impl Scope {
    pub fn of(base: &Url) -> Self {
        Scope(window_scope(base))
    }

    pub fn admits(&self, url: &Url) -> bool {
        url.origin() == self.0.origin()
    }

    fn origin(&self) -> String {
        self.0.origin().ascii_serialization()
    }

    /// The bridge's grant: the app's windows (`app`, `app-*`), remote, this
    /// origin only. The command gate re-checks the label (`is_app_label`).
    fn capability(&self) -> CapabilityBuilder {
        APP_WINDOW_COMMANDS.iter().fold(
            CapabilityBuilder::new("app-window-bridge")
                .window(LABEL)
                .window(format!("{LABEL}-*"))
                .local(false)
                .remote(format!("{}/*", self.origin())),
            |cap, cmd| cap.permission(format!("allow-{}", cmd.replace('_', "-"))),
        )
    }

    /// window_bridge.js with the origin filled in.
    fn bridge_script(&self) -> String {
        BRIDGE_JS.replace("__EQUIN_ORIGIN__", &serde_json::json!(self.origin()).to_string())
    }
}

/// The label of the app window focused last (the first one until another is).
struct LastFocused(Mutex<String>);

/// What a new window of the running process is opened from: the launch, and
/// the number the next window's label takes.
struct Windows {
    launch: Launch,
    next: AtomicUsize,
}

fn last_focused(app: &AppHandle) -> Option<WebviewWindow> {
    let label = app.try_state::<LastFocused>().map(|l| l.0.lock().unwrap().clone());
    label
        .and_then(|l| app.get_webview_window(&l))
        .or_else(|| app.webview_windows().into_values().find(|w| is_app_label(w.label())))
}

/// A later launch's hand-off. No page: the last focused window comes forward.
/// A page of the app: the window already showing it comes forward, else a new
/// window opens on it — never replacing what a window shows.
fn on_handoff(app: &AppHandle, scope: &Url, url: Option<Url>) {
    let Some(url) = url else {
        if let Some(window) = last_focused(app) {
            focus(&window);
        }
        return;
    };
    if !shim::in_scope(scope, &url) {
        eprintln!("equin-desktop: ignoring a hand-off outside the app: {url}");
        return;
    }
    let page = shim::window_url(&url);
    let showing = app
        .webview_windows()
        .into_values()
        .find(|w| is_app_label(w.label()) && w.url().is_ok_and(|u| u == page));
    if let Some(window) = showing {
        eprintln!("equin-desktop: {page} is already in window {}; bringing it forward", window.label());
        focus(&window);
        return;
    }
    let windows = app.state::<Windows>();
    let label = format!("{LABEL}-{}", windows.next.fetch_add(1, Ordering::SeqCst));
    let launch = Launch { url, ..windows.launch.clone() };
    let place = last_focused(app).and_then(|w| frame_of(&w)).map(cascade);
    eprintln!("equin-desktop: opening window {label} on {page}");
    match build_window(app, &label, &launch, Hooks::default(), place) {
        Ok(window) => focus(&window),
        Err(e) => eprintln!("equin-desktop: cannot open a window on {}: {e}", launch.url),
    }
}

/// What a caller watches on, or swaps in, the window; the real launch passes
/// `Hooks::default()`.
#[derive(Clone, Copy)]
pub struct Hooks {
    /// Where an admitted hand-off goes (`scope_gate::hand_off_to_owner`; the
    /// probe records).
    pub hand_off: fn(Url),
    /// Every decision the main-frame gate made: the URL, its frame, admitted.
    pub decided: Option<fn(&Url, FrameKind, bool)>,
    /// A page finished loading in the main frame.
    pub loaded: Option<fn(&WebviewWindow, &Url)>,
    /// The page's `document.title` changed.
    pub title: Option<fn(&WebviewWindow, String)>,
    pub visible: bool,
}

impl Default for Hooks {
    fn default() -> Self {
        Self { hand_off: scope_gate::hand_off_to_owner, decided: None, loaded: None, title: None, visible: true }
    }
}

/// Whether the main-frame gate is on the first window's webview yet.
pub struct GateInstalled(pub Arc<AtomicBool>);

/// Build one of the app's windows, `label` (`LABEL` first), on `launch.url`;
/// `place`: where (`None`: the remembered frame, else centred). The first one
/// also grants the bridge to every window of the app's origin.
pub fn build_window(
    app: &AppHandle,
    label: &str,
    launch: &Launch,
    hooks: Hooks,
    place: Option<Frame>,
) -> tauri::Result<WebviewWindow> {
    let scope = window_scope(&launch.base);
    let home = shim::window_url(&launch.base);
    let sink = hooks.hand_off;
    let installed = Arc::new(AtomicBool::new(false));
    if app.try_state::<Scope>().is_none() {
        app.manage(GateInstalled(installed.clone()));
        app.manage(LastFocused(Mutex::new(label.to_string())));
        let bridge = Scope::of(&launch.base);
        app.add_capability(bridge.capability())?;
        app.manage(bridge);
    }
    let bridge_script = app.state::<Scope>().bridge_script();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(shim::window_url(&launch.url)))
        .title(&launch.name)
        .min_inner_size(480.0, 360.0)
        .visible(hooks.visible)
        .initialization_script(bridge_script)
        .disable_drag_drop_handler()
        .on_new_window(move |url, _features| {
            if web(&url) {
                scope_gate::hand_off(url, sink);
            }
            NewWindowResponse::Deny
        })
        .on_page_load({
            let scope = scope.clone();
            let installed = installed.clone();
            let loaded = hooks.loaded;
            move |window, payload| {
                if !matches!(payload.event(), PageLoadEvent::Finished) {
                    return;
                }
                let url = payload.url();
                if admits_main_frame(&scope, url) {
                    eprintln!("equin-desktop: loaded {url}");
                    assert!(
                        installed.load(Ordering::SeqCst) || url.as_str() == "about:blank",
                        "equin-desktop: {url} loaded before the main-frame gate was installed"
                    );
                } else {
                    // The gate cancels every such load before it happens: reaching
                    // here is a bug. Replace the page natively — never script in it.
                    eprintln!("equin-desktop: BUG: the main frame reached {url} past the gate; going home");
                    if let Err(e) = window.navigate(home.clone()) {
                        eprintln!("equin-desktop: cannot go home to {home}: {e}");
                    }
                }
                if let Some(loaded) = loaded {
                    loaded(&window, url);
                }
            }
        });
    if let Some(title) = hooks.title {
        builder = builder.on_document_title_changed(move |window, t| title(&window, t));
    }
    builder = match place.or_else(|| load_frame(app)) {
        Some(f) => builder.inner_size(f.width, f.height).position(f.x, f.y),
        None => builder.inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1).center(),
    };
    let window = builder.build()?;
    let decided = hooks.decided;
    main_frame::install(
        &window,
        Arc::new(move |url, frame| {
            let admitted = frame == FrameKind::Sub || admits_main_frame(&scope, url);
            if let Some(decided) = decided {
                decided(url, frame, admitted);
            }
            if !admitted {
                if web(url) {
                    eprintln!("equin-desktop: {url} is outside the namespace; refused before it loaded, handing it off");
                    scope_gate::hand_off(url.clone(), sink);
                } else {
                    // A dropped file the page did not take: the drop is nothing.
                    eprintln!("equin-desktop: refused the main-frame load of {url}");
                }
            }
            admitted
        }),
        move || installed.store(true, Ordering::SeqCst),
    )?;
    let w = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { .. } => save_frame(&w),
        WindowEvent::Focused(true) => {
            if let Some(last) = w.app_handle().try_state::<LastFocused>() {
                *last.0.lock().unwrap() = w.label().to_string();
            }
        }
        _ => {}
    });
    Ok(window)
}

pub fn run(launch: Launch) {
    if !shim::valid_app_id(&launch.app_id) {
        eprintln!("equin-desktop: {:?} is not an app id", launch.app_id);
        std::process::exit(2);
    }
    // A plain launch (the app's own URL) only brings a running window forward;
    // a deep URL also moves it there.
    let forwarded = (launch.url != launch.base).then_some(&launch.url);
    let listener = match instance::claim(&launch.app_id, forwarded) {
        instance::Claim::Forwarded => {
            eprintln!("equin-desktop: {} is already open; handed it over", launch.app_id);
            return;
        }
        instance::Claim::Owner(listener) => listener,
    };
    eprintln!("equin-desktop: window mode, app {} ({}), {}", launch.app_id, launch.name, launch.url);

    #[cfg(target_os = "linux")]
    gtk::glib::set_prgname(Some(shim::wm_class(&launch.app_id).as_str()));

    let mut context = crate::context();
    // Per app, not the menu-bar helper's: its config dir (the window frame).
    context.config_mut().identifier = shim::bundle_id(&launch.app_id);
    context.config_mut().product_name = Some(launch.name.clone());
    context.package_info_mut().name = launch.name.clone();

    let owns_socket = listener.is_some();
    let app_id = launch.app_id.clone();
    let app = tauri::Builder::default()
        .invoke_handler(crate::commands::handler())
        .setup(move |app| {
            // The window class (X11 WM_CLASS) and Wayland app id: the shim's
            // StartupWMClass, so the dock groups the window under its entry.
            #[cfg(target_os = "linux")]
            gtk::gdk::set_program_class(&shim::wm_class(&launch.app_id));
            let handle = app.handle().clone();
            build_window(&handle, LABEL, &launch, Hooks::default(), None)?;
            handle.manage(Windows { launch: launch.clone(), next: AtomicUsize::new(2) });
            if let Some(listener) = listener {
                let scope = window_scope(&launch.base);
                instance::serve(listener, move |url| {
                    let target = handle.clone();
                    let scope = scope.clone();
                    let _ = handle.run_on_main_thread(move || on_handoff(&target, &scope, url));
                });
            }
            Ok(())
        })
        .build(context)
        .expect("equin-desktop: cannot build the app window");
    app.run(move |handle, event| match event {
        // The Dock icon clicked while running: bring the window forward.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = last_focused(handle) {
                focus(&window);
            }
        }
        RunEvent::Exit => {
            if owns_socket {
                instance::release(&app_id);
            }
        }
        _ => {
            let _ = handle;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_roams_its_namespace() {
        let scope = window_scope(&Url::parse("http://equin.localhost:9000/mail/inbox").unwrap());
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(shim::in_scope(&scope, &u("http://equin.localhost:9000/home")));
        assert!(shim::in_scope(&scope, &u("http://equin.localhost:9000/agents/c/1")));
        assert!(!shim::in_scope(&scope, &u("http://other.localhost:9000/home")));
        assert!(!shim::in_scope(&scope, &u("https://example.com/")));
    }

    #[test]
    fn every_window_of_the_app_and_nothing_else() {
        for label in ["app", "app-2", "app-17"] {
            assert!(is_app_label(label), "{label}");
        }
        for label in ["panel", "app-", "app-x", "apps", "app-2-3", "other-app-2"] {
            assert!(!is_app_label(label), "{label}");
        }
    }

    #[test]
    fn a_new_window_steps_down_and_right() {
        let from = Frame { x: 100.0, y: 50.0, width: 1200.0, height: 800.0 };
        assert_eq!(cascade(from), Frame { x: 128.0, y: 78.0, width: 1200.0, height: 800.0 });
    }

    #[test]
    fn the_bridge_is_the_origin() {
        use tauri::ipc::RuntimeCapability;
        let bridge = Scope::of(&Url::parse("http://equin.localhost:9000/files").unwrap());
        let tauri::utils::acl::capability::CapabilityFile::Capability(cap) = bridge.capability().build() else {
            panic!("one capability");
        };
        assert_eq!(cap.windows, vec![LABEL.to_string(), format!("{LABEL}-*")]);
        assert!(!cap.local);
        assert_eq!(cap.remote.expect("a remote grant").urls, vec!["http://equin.localhost:9000/*".to_string()]);
        assert_eq!(cap.permissions.len(), APP_WINDOW_COMMANDS.len());
        let js = bridge.bridge_script();
        assert!(!js.contains("__EQUIN_ORIGIN__"));
        assert!(js.contains(r#"var origin = "http://equin.localhost:9000";"#));
    }
}
