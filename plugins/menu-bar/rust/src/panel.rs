//! The panel: one borderless, always-on-top window (label `panel`) created
//! hidden at start and kept alive while hidden, so the page's mounts
//! (notifications, attention) keep running. A tray click toggles it; losing
//! focus hides it.
//!
//! The panel is the bridge's one principal (`Pin`): the bridge's commands are
//! granted to its exact origin only (`capability`), the window loads nothing
//! but the pinned page and the bundled offline page — no other page, and no
//! frame, since the navigation handler sees every frame's loads
//! (`navigation_allowed`) — and each command checks the page the panel shows
//! when it is called (commands.rs's gate), which also catches an in-document
//! route change (`pushState`) no navigation handler sees.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, Rect, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use url::Url;

use crate::command_table::PANEL_COMMANDS;
use crate::{apps, gateway, shim};

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

/// macOS: the panel is a transparent window over the system menu material,
/// clipped to this corner radius (logical px); reported to the page through
/// `host_info`, which draws no background of its own. Elsewhere an opaque
/// square window.
pub const MATERIAL_RADIUS: Option<f64> = if cfg!(target_os = "macos") { Some(12.0) } else { None };

const BRIDGE_JS: &str = include_str!("bridge.js");
/// The panel app's route (menu-bar/core's `menuBarApp.basePath`).
const PANEL_PATH: &str = "/home/menu-bar";

/// The one page the bridge answers: the panel app at the configured
/// instance's exact origin. Everything that admits a page reads it.
#[derive(Clone, Debug)]
pub struct Pin {
    /// The page the panel loads (`?embed=1`: chromeless).
    url: Url,
}

impl Pin {
    pub fn for_namespace(namespace: &str) -> Self {
        let url = Url::parse(&format!("http://{namespace}.localhost:{}{PANEL_PATH}?embed=1", gateway::PORT))
            .expect("a validated namespace makes a valid URL");
        Pin { url }
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    /// The instance's origin as a URL (`http://<ns>.localhost:9000/`).
    pub fn origin_url(&self) -> Url {
        let mut u = self.url.clone();
        u.set_path("/");
        u.set_query(None);
        u
    }

    /// `http://<ns>.localhost:9000` — what the ACL and bridge.js match.
    pub fn origin(&self) -> String {
        self.url.origin().ascii_serialization()
    }

    /// The pinned page: the exact origin, on the panel's route (any query).
    pub fn admits(&self, url: &Url) -> bool {
        url.origin() == self.url.origin()
            && (url.path() == PANEL_PATH || url.path().starts_with(&format!("{PANEL_PATH}/")))
    }

    /// The bridge's grant: window `panel`, remote, this origin only — never a
    /// pattern over namespaces, so a page elsewhere is not covered (and the
    /// invoke key Tauri logs on a bad call is useless to it). The ACL sees
    /// only the origin (the fetch IPC carries the `Origin` header); the path
    /// and the frame are the navigation handler's and the command gate's.
    pub fn capability(&self) -> CapabilityBuilder {
        PANEL_COMMANDS.iter().fold(
            CapabilityBuilder::new("panel-bridge")
                .window(LABEL)
                .local(false)
                .remote(format!("{}/*", self.origin())),
            |cap, cmd| cap.permission(format!("allow-{}", cmd.replace('_', "-"))),
        )
    }

    /// bridge.js with the pinned origin and route filled in.
    fn bridge_script(&self) -> String {
        let pin = serde_json::json!({ "origin": self.origin(), "path": PANEL_PATH });
        BRIDGE_JS.replace("__EQUIN_PIN__", &pin.to_string())
    }
}

/// The bundled offline page (`frontend/index.html`) as the webview loads it.
pub fn is_offline_page(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => cfg!(windows) && url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Every load in the panel window — the page and each of its frames (the
/// handler cannot tell them apart, so a frame is held to the same rule): the
/// pinned page or the offline page, nothing else. Same-origin frames (a
/// prototype, `srcdoc`) would otherwise reach `top.equinNative`.
pub fn navigation_allowed(pin: &Pin, url: &Url) -> bool {
    pin.admits(url) || is_offline_page(url)
}

pub struct Panel {
    pin: Pin,
    hidden_at: Mutex<Option<Instant>>,
    /// Where a link the panel opens in a new window goes (the default
    /// browser; the probe records it instead).
    hand_off: fn(&Url),
}

impl Panel {
    pub fn new(pin: Pin, hand_off: fn(&Url)) -> Self {
        Panel { pin, hidden_at: Mutex::new(None), hand_off }
    }

    pub fn pin(&self) -> &Pin {
        &self.pin
    }

    pub fn url(&self) -> &Url {
        self.pin.url()
    }
}

/// A new-window request from the panel (`target=_blank`, cmd-click): the
/// default browser, never a window.
pub fn open_in_browser(url: &Url) {
    // On a thread: `open` is waited on, and this runs on the webview's.
    let url = url.clone();
    std::thread::spawn(move || {
        if let Err(e) = shim::open_in_browser(&url) {
            eprintln!("equin-desktop: the panel's link to {url} did not open: {e}");
        }
    });
}

fn offline_url() -> WebviewUrl {
    WebviewUrl::App("index.html".into())
}

fn showing_remote(window: &WebviewWindow) -> bool {
    window.url().map(|u| u.scheme() == "http" && u.port() == Some(gateway::PORT)).unwrap_or(false)
}

/// What the probe (src/probe.rs) watches on the panel; the tray passes none.
pub struct Observer {
    /// A page finished loading in the main frame.
    pub loaded: fn(&WebviewWindow, &Url),
    /// A load (the page's or a frame's) the panel refused.
    pub refused: fn(&Url),
    /// The page's `document.title` changed.
    pub title: fn(&WebviewWindow, String),
}

/// Create the hidden panel window: the equin page if the gateway answers, else
/// the bundled offline page.
pub fn create(app: &AppHandle, observer: Option<Observer>) -> tauri::Result<WebviewWindow> {
    let panel = app.state::<Panel>();
    let initial = if gateway::up() {
        WebviewUrl::External(panel.url().clone())
    } else {
        eprintln!("equin-desktop: nothing answers on port {}; panel shows the offline page", gateway::PORT);
        offline_url()
    };
    let pin = panel.pin().clone();
    let load_pin = pin.clone();
    let hand_off = panel.hand_off;
    let refused = observer.as_ref().map(|o| o.refused);
    let loaded = observer.as_ref().map(|o| o.loaded);
    let builder = WebviewWindowBuilder::new(app, LABEL, initial)
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
        .initialization_script(panel.pin().bridge_script())
        .on_navigation(move |url| {
            let allowed = navigation_allowed(&pin, url);
            if !allowed {
                eprintln!("equin-desktop: panel refused {url}");
                if let Some(refused) = refused {
                    refused(url);
                }
            }
            allowed
        })
        .on_new_window(move |url, _features| {
            if url.scheme() == "http" || url.scheme() == "https" {
                hand_off(&url);
            } else {
                eprintln!("equin-desktop: panel refused a new window on {url}");
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            // The pinned page starting to load (tray start, a reload onto a
            // new web bundle — what a changed app set is): the keeper (the
            // main instance's tray only) syncs the installed apps, marked
            // before the page's scripts run, so its first `apps()` waits.
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) && load_pin.admits(payload.url()) {
                if let Some(keeper) = window.app_handle().try_state::<std::sync::Arc<apps::Keeper>>() {
                    keeper.begin_sync();
                }
            }
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                eprintln!("equin-desktop: panel loaded {}", payload.url());
                if let Some(loaded) = loaded {
                    loaded(&window, payload.url());
                }
            }
        });
    let builder = match observer {
        Some(o) => builder.on_document_title_changed(move |window, title| (o.title)(&window, title)),
        None => builder,
    };
    let window = with_material(builder).build()?;

    let handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            hide(&handle);
        }
    });
    Ok(window)
}

/// macOS: transparent window + the menu vibrancy material, rounded. The panel
/// page is designed light, so the window pins the light appearance (else the
/// material turns dark with the system and the light page sits on it).
#[cfg(target_os = "macos")]
fn with_material<'a, M: Manager<tauri::Wry>>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, M>,
) -> WebviewWindowBuilder<'a, tauri::Wry, M> {
    use tauri::utils::config::WindowEffectsConfig;
    use tauri::utils::{WindowEffect, WindowEffectState};
    builder
        .transparent(true)
        // The bundled offline page has no bridge; this tells it (and only it)
        // that its window is a transparent material, so it rounds itself.
        .initialization_script(
            "if (location.protocol === 'tauri:') document.documentElement.setAttribute('data-material', '');",
        )
        .theme(Some(tauri::Theme::Light))
        .effects(WindowEffectsConfig {
            effects: vec![WindowEffect::Menu],
            state: Some(WindowEffectState::Active),
            radius: MATERIAL_RADIUS,
            color: None,
            interactive: false,
        })
}

#[cfg(not(target_os = "macos"))]
fn with_material<'a, M: Manager<tauri::Wry>>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, M>,
) -> WebviewWindowBuilder<'a, tauri::Wry, M> {
    builder
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

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::RuntimeCapability;
    use tauri::utils::acl::capability::CapabilityFile;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_panel_loads_its_page_and_nothing_else() {
        let pin = Pin::for_namespace("equin");
        assert_eq!(pin.url().as_str(), "http://equin.localhost:9000/home/menu-bar?embed=1");
        assert!(navigation_allowed(&pin, pin.url()));
        assert!(navigation_allowed(&pin, &u("tauri://localhost/index.html")));
        for refused in [
            "http://other.localhost:9000/home/menu-bar?embed=1",
            "http://equin.localhost:9000/prototypes/x/index.html",
            "http://equin.localhost:9000/agents",
            "about:srcdoc",
            "about:blank",
            "data:text/html,<script>top</script>",
            "https://example.com/",
        ] {
            assert!(!navigation_allowed(&pin, &u(refused)), "{refused}");
        }
    }

    #[test]
    fn the_grant_is_the_exact_origin() {
        let CapabilityFile::Capability(cap) = Pin::for_namespace("equin").capability().build() else {
            panic!("one capability");
        };
        assert_eq!(cap.windows, vec![LABEL.to_string()]);
        assert!(!cap.local);
        let remote = cap.remote.expect("a remote grant");
        assert_eq!(remote.urls, vec!["http://equin.localhost:9000/*".to_string()]);
        assert_eq!(cap.permissions.len(), PANEL_COMMANDS.len());
    }

    #[test]
    fn the_bridge_script_carries_the_pin() {
        let js = Pin::for_namespace("equin").bridge_script();
        assert!(!js.contains("__EQUIN_PIN__"));
        assert!(js.contains(r#""origin":"http://equin.localhost:9000""#));
    }
}
