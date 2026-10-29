//! Window mode: one installed app's own process — a regular app with its own
//! Dock icon (macOS: the shim bundle's identity) or window class (Linux:
//! `equin-<id>`, the shim's `StartupWMClass`), and ONE window on the app's URL
//! as the app's own document (never `?embed=`, see `shim::window_url`). The
//! window gets no IPC — no capability names its label — and no script is
//! injected into any page it shows.
//!
//! It keeps to its namespace (`window_scope`: the app URL's whole origin, not
//! its base path), so the app's own ways to other apps — the launcher, a link
//! into another app — stay in this window. The holder decides, before the
//! fact: a main-frame load off the origin (a link, a form, `location.*`, a
//! server redirect) is cancelled natively before it loads (`src/main_frame.rs`)
//! and handed to the installed app owning the URL, else the default browser
//! (`shim::hand_off`); every `window.open` / `target=_blank` is handed off
//! the same way, never a second webview window. Frames are untouched: an app
//! frames content origins and foreign sites. Hand-offs go through one burst
//! gate (`scope_gate::hand_off`), so a page cannot flood the browser.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

use crate::main_frame::{self, FrameKind};
use crate::scope_gate::{self, admits_main_frame, web};
use crate::{instance, shim};

const LABEL: &str = "app";
const DEFAULT_SIZE: (f64, f64) = (1200.0, 800.0);

/// What a window-mode process opens.
#[derive(Debug, PartialEq)]
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
#[derive(Serialize, Deserialize, Clone, Copy)]
struct Frame {
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

fn save_frame(window: &WebviewWindow) {
    let (Ok(scale), Ok(pos), Ok(size)) = (window.scale_factor(), window.outer_position(), window.inner_size()) else {
        return;
    };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    let frame = Frame { x: pos.x, y: pos.y, width: size.width, height: size.height };
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

/// A later launch's hand-off: come forward, and go to its URL when it is ours.
fn on_handoff(app: &AppHandle, scope: &Url, url: Option<Url>) {
    let Some(window) = app.get_webview_window(LABEL) else { return };
    focus(&window);
    if let Some(url) = url {
        if shim::in_scope(scope, &url) {
            if let Err(e) = window.navigate(shim::window_url(&url)) {
                eprintln!("equin-desktop: cannot navigate to {url}: {e}");
            }
        } else {
            eprintln!("equin-desktop: ignoring a hand-off outside the app: {url}");
        }
    }
}

/// What a caller watches on, or swaps in, the window; the real launch passes
/// `Hooks::default()`.
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

/// Whether the main-frame gate is on the window's webview yet.
pub struct GateInstalled(pub Arc<AtomicBool>);

pub fn build_window(app: &AppHandle, launch: &Launch, hooks: Hooks) -> tauri::Result<WebviewWindow> {
    let scope = window_scope(&launch.base);
    let home = shim::window_url(&launch.base);
    let sink = hooks.hand_off;
    let installed = Arc::new(AtomicBool::new(false));
    app.manage(GateInstalled(installed.clone()));
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(shim::window_url(&launch.url)))
        .title(&launch.name)
        .min_inner_size(480.0, 360.0)
        .visible(hooks.visible)
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
    builder = match load_frame(app) {
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
                eprintln!("equin-desktop: {url} is outside the namespace; refused before it loaded, handing it off");
                scope_gate::hand_off(url.clone(), sink);
            }
            admitted
        }),
        move || installed.store(true, Ordering::SeqCst),
    )?;
    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { .. } = event {
            save_frame(&w);
        }
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
        .setup(move |app| {
            // The window class (X11 WM_CLASS) and Wayland app id: the shim's
            // StartupWMClass, so the dock groups the window under its entry.
            #[cfg(target_os = "linux")]
            gtk::gdk::set_program_class(&shim::wm_class(&launch.app_id));
            let handle = app.handle().clone();
            build_window(&handle, &launch, Hooks::default())?;
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
            if let Some(window) = handle.get_webview_window(LABEL) {
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
}
