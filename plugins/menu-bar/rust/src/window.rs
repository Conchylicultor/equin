//! Window mode: one installed app's own process — a regular app with its own
//! Dock icon (macOS: the shim bundle's identity) or window class (Linux:
//! `equin-<id>`, the shim's `StartupWMClass`), and ONE window on the app's URL
//! as the app's own document (never `?embed=`, see `shim::window_url`). The
//! window gets no IPC — no capability names its label.
//!
//! It keeps to its namespace (`window_scope`: the app URL's whole origin, not
//! its base path), so the app's own ways to other apps — the launcher, a link
//! into another app — stay in this window. A navigation off the origin is
//! cancelled and handed to the installed app owning the URL, else the default
//! browser (`shim::hand_off`). Three catches, since a navigation handler cannot
//! tell the main frame from an iframe:
//! - `src/scope.js` (main frame): off-origin link clicks become `window.open`;
//! - the new-window handler: every `window.open` / `target=_blank` is handed
//!   off, never a second webview window;
//! - any other main-frame load that lands off the origin is handed off and
//!   stepped back from once it has loaded (an iframe may load any origin, so
//!   only the page-load event — main frame only — can tell).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

use crate::{instance, shim};

const LABEL: &str = "app";
const SCOPE_JS: &str = include_str!("scope.js");
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

fn web(url: &Url) -> bool {
    url.scheme() == "http" || url.scheme() == "https"
}

/// Hand off on a thread: it reads the shims from disk and waits on `open`.
fn hand_off(url: Url) {
    std::thread::spawn(move || shim::hand_off(&url));
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

fn scope_script(scope: &Url) -> String {
    let scope = serde_json::json!({
        "origin": scope.origin().ascii_serialization(),
        "base": scope.path().trim_end_matches('/'),
    });
    SCOPE_JS.replace("__EQUIN_SCOPE__", &scope.to_string())
}

fn build_window(app: &AppHandle, launch: &Launch) -> tauri::Result<WebviewWindow> {
    let scope = window_scope(&launch.base);
    let home = shim::window_url(&launch.base);
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(shim::window_url(&launch.url)))
        .title(&launch.name)
        .min_inner_size(480.0, 360.0)
        .initialization_script(scope_script(&scope))
        .on_new_window(|url, _features| {
            if web(&url) {
                hand_off(url);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let url = payload.url();
            if !web(url) || shim::in_scope(&scope, url) {
                eprintln!("equin-desktop: loaded {url}");
                return;
            }
            eprintln!("equin-desktop: {url} is outside the namespace; handing it off");
            hand_off(url.clone());
            let back = format!(
                "if (history.length > 1) history.back(); else location.replace({});",
                serde_json::Value::String(home.to_string())
            );
            if let Err(e) = window.eval(back) {
                eprintln!("equin-desktop: cannot step back into the app: {e}");
            }
        });
    builder = match load_frame(app) {
        Some(f) => builder.inner_size(f.width, f.height).position(f.x, f.y),
        None => builder.inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1).center(),
    };
    let window = builder.build()?;
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
            build_window(&handle, &launch)?;
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
    fn scope_script_is_filled() {
        let js = scope_script(&window_scope(&Url::parse("http://equin.localhost:9000/mail").unwrap()));
        assert!(!js.contains("__EQUIN_SCOPE__"));
        assert!(js.contains(r#""base":"""#));
        assert!(js.contains(r#""origin":"http://equin.localhost:9000""#));
    }

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
