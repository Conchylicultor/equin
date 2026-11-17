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
//!
//! The pin's origin carries the gateway's port, which can move under a
//! running tray (`gateway::listening_port`, read again at every show): when the port
//! file names another port than the panel was built on, the window is
//! destroyed and built again on the new origin — its grant, navigation pin
//! and bridge script are all fixed at build — and shown once it is.

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
#[derive(Clone, Debug, PartialEq)]
pub struct Pin {
    /// The page the panel loads (`?embed=1`: chromeless).
    url: Url,
}

impl Pin {
    /// The panel of `namespace` on the gateway's `port`, at the host it is
    /// handed out under (main: `equin.localhost`, not its internal name).
    pub fn new(namespace: &str, port: u16) -> Self {
        let host = crate::cli::host_label(namespace);
        let url = Url::parse(&format!("http://{host}.localhost:{port}{PANEL_PATH}?embed=1"))
            .expect("a validated namespace makes a valid URL");
        Pin { url }
    }

    /// The panel of `namespace` on the port the gateway listens on now.
    pub fn current(namespace: &str) -> Result<Self, String> {
        Ok(Self::new(namespace, gateway::listening_port()?))
    }

    pub fn url(&self) -> &Url {
        &self.url
    }

    /// The gateway port the pin is on.
    pub fn port(&self) -> u16 {
        self.url.port_or_known_default().expect("an http URL has a port")
    }

    /// The instance's origin as a URL (`http://<ns>.localhost:<port>/`).
    pub fn origin_url(&self) -> Url {
        let mut u = self.url.clone();
        u.set_path("/");
        u.set_query(None);
        u
    }

    /// `http://<ns>.localhost:<port>` — what the ACL and bridge.js match.
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
    /// A grant cannot be withdrawn: after a port move the old origin's stays,
    /// and the command gate (the current pin) refuses it.
    pub fn capability(&self) -> CapabilityBuilder {
        PANEL_COMMANDS.iter().fold(
            CapabilityBuilder::new(format!("panel-bridge-{}", self.port()))
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
/// A panel built with no pin (the port file was unreadable) loads the offline
/// page only.
pub fn navigation_allowed(pin: Option<&Pin>, url: &Url) -> bool {
    pin.is_some_and(|p| p.admits(url)) || is_offline_page(url)
}

pub struct Panel {
    namespace: String,
    /// The pin the panel window was built on: `None` when the port file was
    /// unreadable then (the window shows the offline page and its error).
    built: Mutex<Option<Pin>>,
    /// The window is being rebuilt on another origin: `Some(show)`, whether
    /// to show it once it is (the show that found the port moved; the
    /// offline page's Start, when it was shown).
    rebuilding: Mutex<Option<bool>>,
    /// Where the last show put the panel (a rebuilt one shows there).
    anchor: Mutex<Anchor>,
    hidden_at: Mutex<Option<Instant>>,
    /// Where a link the panel opens in a new window goes (the default
    /// browser; the probe records it instead).
    hand_off: fn(&Url),
    /// What the probe watches; the tray passes none.
    observer: Option<Observer>,
}

impl Panel {
    pub fn new(namespace: String, hand_off: fn(&Url), observer: Option<Observer>) -> Self {
        Panel {
            namespace,
            built: Mutex::new(None),
            rebuilding: Mutex::new(None),
            anchor: Mutex::new(None),
            hidden_at: Mutex::new(None),
            hand_off,
            observer,
        }
    }

    /// The pin the window was built on (`None`: built without one).
    pub fn pin(&self) -> Option<Pin> {
        self.built.lock().unwrap().clone()
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

/// The offline page's query: the port nothing answers on, or why the port is
/// not known (the page says which; it names no port of its own).
fn offline_query(port: &Result<u16, String>) -> String {
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    match port {
        Ok(port) => q.append_pair("port", &port.to_string()),
        Err(e) => q.append_pair("error", e),
    };
    q.finish()
}

/// The bundled offline page's URL as the webview loads it on this platform,
/// telling it about `port`.
fn offline_url(port: &Result<u16, String>) -> Url {
    let raw = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    let mut url = Url::parse(raw).expect("static URL");
    url.set_query(Some(&offline_query(port)));
    url
}

/// What the panel should show: the pinned page when the gateway answers on
/// the pin's port, else the offline page saying why.
fn wanted(pin: &Result<Pin, String>) -> Url {
    match pin {
        Ok(pin) if gateway::up(pin.port()) => pin.url().clone(),
        Ok(pin) => {
            eprintln!("equin-desktop: nothing answers on port {}; panel shows the offline page", pin.port());
            offline_url(&Ok(pin.port()))
        }
        Err(e) => {
            eprintln!("equin-desktop: {e}; panel shows the offline page");
            offline_url(&Err(e.clone()))
        }
    }
}

/// Does `shown` already show `target`? The pinned page on any of its routes
/// (an in-document route change is the page's own), the offline page only
/// with the same message.
fn shows(target: &Url, shown: &Url) -> bool {
    if is_offline_page(target) {
        is_offline_page(shown) && shown.query() == target.query()
    } else {
        shown.origin() == target.origin()
    }
}

/// What the probe (src/probe.rs) watches on the panel; the tray passes none.
#[derive(Clone, Copy)]
pub struct Observer {
    /// A page finished loading in the main frame.
    pub loaded: fn(&WebviewWindow, &Url),
    /// A load (the page's or a frame's) the panel refused.
    pub refused: fn(&Url),
    /// The page's `document.title` changed.
    pub title: fn(&WebviewWindow, String),
}

/// Create the hidden panel window on the gateway's current port, its bridge
/// granted to that origin: the equin page if the gateway answers, else the
/// bundled offline page.
pub fn create(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let panel = app.state::<Panel>();
    let current = Pin::current(&panel.namespace);
    let initial = match &wanted(&current) {
        u if is_offline_page(u) => WebviewUrl::App(format!("index.html?{}", u.query().unwrap_or("")).into()),
        u => WebviewUrl::External(u.clone()),
    };
    let pin = current.ok();
    if let Some(pin) = &pin {
        app.add_capability(pin.capability())?;
    }
    *panel.built.lock().unwrap() = pin.clone();
    let observer = panel.observer;
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
        .shadow(true);
    // No pin, no bridge: the offline page is all such a window loads.
    let builder = match &pin {
        Some(p) => builder.initialization_script(p.bridge_script()),
        None => builder,
    };
    let builder = builder
        .on_navigation(move |url| {
            let allowed = navigation_allowed(pin.as_ref(), url);
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
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
                && load_pin.as_ref().is_some_and(|p| p.admits(payload.url()))
            {
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
    eprintln!("equin-desktop: panel built on {}", window.url().map_or_else(|e| e.to_string(), |u| u.to_string()));

    let handle = app.clone();
    let shaped = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => hide(&handle),
        WindowEvent::Resized(_) => reshadow(&shaped),
        _ => {}
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

/// Is a rebuild owed? The port file names a port (`current` is a pin) the
/// window was not built on. An unreadable port file is not one: the window
/// shows the offline page and its error, whatever it was built on.
fn moved(built: Option<&Pin>, current: &Result<Pin, String>) -> bool {
    matches!(current, Ok(pin) if built != Some(pin))
}

/// Before a show: `false` when the port moved since the window was built —
/// it is destroyed and built again on the new origin (`destroyed`), and shown
/// once it is when `show` says so. Otherwise point it at the equin page or the
/// offline page, whichever the gateway's presence calls for, when it shows
/// the other.
fn reconcile(app: &AppHandle, window: &WebviewWindow, show: bool) -> bool {
    let panel = app.state::<Panel>();
    let current = Pin::current(&panel.namespace);
    if moved(panel.pin().as_ref(), &current) {
        eprintln!(
            "equin-desktop: the gateway's port moved ({} → {}); rebuilding the panel",
            panel.pin().map_or_else(|| "unknown".into(), |p| p.port().to_string()),
            current.as_ref().map_or(0, Pin::port),
        );
        *panel.rebuilding.lock().unwrap() = Some(show);
        if let Err(e) = window.destroy() {
            *panel.rebuilding.lock().unwrap() = None;
            eprintln!("equin-desktop: the panel cannot be rebuilt: {e}");
        }
        return false;
    }
    let target = wanted(&current);
    if window.url().is_ok_and(|shown| shows(&target, &shown)) {
        return true;
    }
    if let Err(e) = window.navigate(target.clone()) {
        eprintln!("equin-desktop: panel cannot navigate to {target}: {e}");
    }
    true
}

/// The panel window was destroyed (the run loop's `Destroyed`, once its label
/// is free): when a show rebuilt it, build it again on the current port and
/// show it where the last show put it. A rebuild loads the pinned page, which
/// starts the keeper's sync — rewriting every shim onto the new origin.
pub fn destroyed(app: &AppHandle) {
    let panel = app.state::<Panel>();
    let Some(visible) = panel.rebuilding.lock().unwrap().take() else { return };
    match create(app) {
        Ok(window) if visible => show(&window, *panel.anchor.lock().unwrap()),
        Ok(_) => {}
        Err(e) => eprintln!("equin-desktop: the panel could not be rebuilt: {e}"),
    }
}

/// Load the equin page now (the gateway just came up) — rebuilding the
/// window when it came up on another port than the panel was built on.
pub fn load_remote(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let visible = window.is_visible().unwrap_or(false);
        reconcile(app, &window, visible);
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
    *app.state::<Panel>().anchor.lock().unwrap() = anchor;
    if reconcile(app, &window, true) {
        show(&window, anchor);
    }
}

fn show(window: &WebviewWindow, anchor: Anchor) {
    if let Some(pos) = position(window, anchor) {
        let _ = window.set_position(pos);
    }
    let _ = window.show();
    reshadow(window);
    let _ = window.set_focus();
}

/// Recompute the window's shadow from what it shows now. macOS derives a
/// transparent window's shadow from its alpha but never re-derives it by
/// itself: a shadow taken from an earlier frame (another height, a page that
/// had not painted its rounded material yet) outlived it, drawing square
/// bottom corners under the rounded material until the helper restarted.
/// Done on every resize and every show, so the shadow is always the current
/// rounded shape.
#[cfg(target_os = "macos")]
fn reshadow(window: &WebviewWindow) {
    let target = window.clone();
    let queued = window.run_on_main_thread(move || match target.ns_window() {
        // SAFETY: Tauri's NSWindow pointer for this live window, used on the
        // main thread.
        Ok(ptr) => unsafe { (*(ptr as *const objc2_app_kit::NSWindow)).invalidateShadow() },
        Err(e) => eprintln!("equin-desktop: panel shadow not refreshed: {e}"),
    });
    if let Err(e) = queued {
        eprintln!("equin-desktop: panel shadow not refreshed: {e}");
    }
}

#[cfg(not(target_os = "macos"))]
fn reshadow(_window: &WebviewWindow) {}

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
    fn the_pin_is_on_the_gateways_port() {
        let pin = Pin::new("equin", 8700);
        assert_eq!(pin.url().as_str(), "http://equin.localhost:8700/home/menu-bar?embed=1");
        assert_eq!(pin.port(), 8700);
        assert_eq!(pin.origin(), "http://equin.localhost:8700");
        assert_eq!(pin.origin_url().as_str(), "http://equin.localhost:8700/");
        assert_eq!(Pin::new("equin", 9000).origin(), "http://equin.localhost:9000");
        // The old port's page is another origin: not the pin.
        assert!(!pin.admits(&u("http://equin.localhost:9000/home/menu-bar?embed=1")));
    }

    #[test]
    fn a_moved_port_rebuilds_the_panel() {
        let old = Pin::new("equin", 9000);
        let new = Pin::new("equin", 8700);
        assert!(moved(Some(&old), &Ok(new.clone())));
        assert!(!moved(Some(&new), &Ok(new.clone())));
        // Built without a pin (the port file was unreadable), now readable.
        assert!(moved(None, &Ok(new.clone())));
        // Unreadable now: the offline page says so, no rebuild.
        assert!(!moved(Some(&new), &Err("broken".into())));
        assert!(!moved(None, &Err("broken".into())));
    }

    #[test]
    fn the_offline_page_is_told_the_port_or_the_error() {
        let on = offline_url(&Ok(8700));
        assert!(is_offline_page(&on));
        assert_eq!(on.query(), Some("port=8700"));
        let broken = offline_url(&Err("the port file is bad".into()));
        assert_eq!(broken.query(), Some("error=the+port+file+is+bad"));
        assert!(shows(&on, &on));
        assert!(!shows(&on, &broken));
        let pin = Pin::new("equin", 8700);
        assert!(shows(pin.url(), &u("http://equin.localhost:8700/home/menu-bar/x")));
        assert!(!shows(pin.url(), &u("http://equin.localhost:9000/home/menu-bar?embed=1")));
        assert!(!shows(pin.url(), &on));
    }

    #[test]
    fn the_panel_loads_its_page_and_nothing_else() {
        let pin = Pin::new("equin", 9000);
        assert_eq!(pin.url().as_str(), "http://equin.localhost:9000/home/menu-bar?embed=1");
        assert_eq!(
            Pin::new(crate::cli::MAIN_NAMESPACE, 9000).url().as_str(),
            "http://equin.localhost:9000/home/menu-bar?embed=1"
        );
        let pin = Some(&pin);
        assert!(navigation_allowed(pin, pin.unwrap().url()));
        assert!(navigation_allowed(pin, &u("tauri://localhost/index.html")));
        assert!(navigation_allowed(None, &u("tauri://localhost/index.html?error=x")));
        assert!(!navigation_allowed(None, &u("http://equin.localhost:9000/home/menu-bar?embed=1")));
        for refused in [
            "http://other.localhost:9000/home/menu-bar?embed=1",
            "http://equin.localhost:9000/prototypes/x/index.html",
            "http://equin.localhost:9000/agents",
            "about:srcdoc",
            "about:blank",
            "data:text/html,<script>top</script>",
            "https://example.com/",
        ] {
            assert!(!navigation_allowed(pin, &u(refused)), "{refused}");
        }
    }

    #[test]
    fn the_grant_is_the_exact_origin() {
        let CapabilityFile::Capability(cap) = Pin::new("equin", 9000).capability().build() else {
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
        let js = Pin::new("equin", 9000).bridge_script();
        assert!(!js.contains("__EQUIN_PIN__"));
        assert!(js.contains(r#""origin":"http://equin.localhost:9000""#));
    }
}
