//! The panel: one borderless, always-on-top window (label `panel`) created
//! hidden at start and kept alive while hidden, so the page's mounts
//! (notifications, attention) keep running. A tray click toggles it; losing
//! focus hides it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Rect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use url::Url;

use crate::gateway;

pub const LABEL: &str = "panel";
pub const WIDTH: f64 = 360.0;
const INITIAL_HEIGHT: f64 = 560.0;
pub const MIN_HEIGHT: f64 = 200.0;
pub const MAX_HEIGHT: f64 = 720.0;
/// Gap between the menu bar (or the icon) and the panel, in logical px.
const MARGIN: f64 = 6.0;
/// A tray click this soon after a blur-hide is the same click that blurred it:
/// the user meant "close", so it must not reopen.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

const BRIDGE_JS: &str = include_str!("bridge.js");

pub struct Panel {
    url: Url,
    hidden_at: Mutex<Option<Instant>>,
}

impl Panel {
    pub fn new(namespace: &str) -> Self {
        let url = Url::parse(&format!(
            "http://{namespace}.localhost:{}/home/menu-bar?embed=1",
            gateway::PORT
        ))
        .expect("a validated namespace makes a valid URL");
        Panel { url, hidden_at: Mutex::new(None) }
    }

    pub fn url(&self) -> &Url {
        &self.url
    }
}

fn offline_url() -> WebviewUrl {
    WebviewUrl::App("index.html".into())
}

fn showing_remote(window: &WebviewWindow) -> bool {
    window.url().map(|u| u.scheme() == "http" && u.port() == Some(gateway::PORT)).unwrap_or(false)
}

/// Create the hidden panel window: the equin page if the gateway answers, else
/// the bundled offline page.
pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let panel = app.state::<Panel>();
    let initial = if gateway::up() {
        WebviewUrl::External(panel.url().clone())
    } else {
        eprintln!("equin-desktop: nothing answers on port {}; panel shows the offline page", gateway::PORT);
        offline_url()
    };
    let window = WebviewWindowBuilder::new(app, LABEL, initial)
        .title("equin")
        .inner_size(WIDTH, INITIAL_HEIGHT)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false)
        .focused(true)
        .shadow(true)
        .initialization_script(BRIDGE_JS)
        .on_page_load(|_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                eprintln!("equin-desktop: panel loaded {}", payload.url());
            }
        })
        .build()?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            hide(&handle);
        }
    });
    Ok(window)
}

/// Point the panel at the equin page or the offline page, whichever the
/// gateway's presence calls for, when it shows the other one.
pub fn reconcile(app: &AppHandle, window: &WebviewWindow) {
    let up = gateway::up();
    if up == showing_remote(window) {
        return;
    }
    let target = if up { app.state::<Panel>().url().clone() } else { tauri_local_index() };
    if let Err(e) = window.navigate(target.clone()) {
        eprintln!("equin-desktop: panel cannot navigate to {target}: {e}");
    }
}

/// The bundled index page's URL as the webview loads it on this platform.
fn tauri_local_index() -> Url {
    let raw = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    Url::parse(raw).expect("static URL")
}

/// Load the equin page now (the gateway just came up).
pub fn load_remote(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let url = app.state::<Panel>().url().clone();
        if let Err(e) = window.navigate(url.clone()) {
            eprintln!("equin-desktop: panel cannot navigate to {url}: {e}");
        }
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.is_visible().unwrap_or(false) {
            *app.state::<Panel>().hidden_at.lock().unwrap() = Some(Instant::now());
            let _ = window.hide();
        }
    }
}

/// Where the tray icon is, when the platform says (macOS: the status item's
/// rect, physical px).
pub type Anchor = Option<Rect>;

/// A tray click: show the panel under the icon, or hide it if it is shown.
pub fn toggle(app: &AppHandle, anchor: Anchor) {
    let Some(window) = app.get_webview_window(LABEL) else {
        eprintln!("equin-desktop: no panel window");
        return;
    };
    if window.is_visible().unwrap_or(false) {
        hide(app);
        return;
    }
    let just_hidden = app
        .state::<Panel>()
        .hidden_at
        .lock()
        .unwrap()
        .is_some_and(|t| t.elapsed() < REOPEN_GUARD);
    if just_hidden {
        return;
    }
    reconcile(app, &window);
    if let Some(pos) = position(&window, anchor) {
        let _ = window.set_position(pos);
    }
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn set_height(window: &WebviewWindow, px: f64) -> tauri::Result<f64> {
    let h = if px.is_finite() { px.clamp(MIN_HEIGHT, MAX_HEIGHT) } else { INITIAL_HEIGHT };
    window.set_size(LogicalSize::new(WIDTH, h))?;
    Ok(h)
}

/// Under the icon, centred on it and kept on its monitor (macOS); top-right
/// under the bar when there is no icon rect (Linux — and on Wayland the
/// compositor places the window anyway).
fn position(window: &WebviewWindow, anchor: Anchor) -> Option<PhysicalPosition<i32>> {
    let size = window.outer_size().ok()?;
    let w = size.width as f64;
    match anchor {
        Some(rect) => {
            let monitor = window
                .monitor_from_point(
                    rect.position.to_physical::<f64>(1.0).x,
                    rect.position.to_physical::<f64>(1.0).y,
                )
                .ok()
                .flatten()
                .or_else(|| window.current_monitor().ok().flatten())?;
            let scale = monitor.scale_factor();
            let pos = rect.position.to_physical::<f64>(scale);
            let icon = rect.size.to_physical::<f64>(scale);
            let area = monitor.work_area();
            let left = area.position.x as f64;
            let right = left + area.size.width as f64;
            let x = (pos.x + icon.width / 2.0 - w / 2.0).clamp(left + MARGIN * scale, right - w - MARGIN * scale);
            let y = pos.y + icon.height + MARGIN * scale;
            Some(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        }
        None => {
            let monitor = window.primary_monitor().ok().flatten()?;
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let x = area.position.x as f64 + area.size.width as f64 - w - MARGIN * scale;
            let y = area.position.y as f64 + MARGIN * scale;
            Some(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        }
    }
}
