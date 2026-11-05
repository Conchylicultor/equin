//! The bridge's commands (`window.equinNative`, src/bridge.js), an app
//! window's (`window.equinWindow`, src/window_bridge.js) and the offline
//! page's Start. Each is ACL-gated — the bridge to the panel window on the
//! pinned origin (granted at runtime, `panel::Pin::capability`), the app
//! window's to that window on its origin (`window::Scope::capability`),
//! `start_gateway` to the panel's bundled page (capabilities/panel-offline.json)
//! — and then gated again here (`handler`) on the page the calling window
//! shows right now, by its row in src/command_table.rs.

use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Invoke;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use url::Url;

use crate::command_table::{APP_WINDOW_COMMANDS, OFFLINE_COMMANDS, PANEL_COMMANDS};
use crate::{apps, file_drag, gateway, panel, shim, tray, window};

/// Bump on a breaking change of the bridge; the web side reads it.
const BRIDGE_VERSION: u8 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    notify: bool,
    attention: bool,
    launch_app: bool,
    open_url: bool,
    /// This helper keeps the device's installed apps (`apps`, `pin_app`):
    /// the main instance's tray only.
    apps: bool,
    /// It can pin one to the Dock / GNOME dash.
    pin: bool,
}

/// The panel window is a transparent vibrancy material (macOS): the page must
/// paint no background of its own and round its corners at this radius.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    corner_radius: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    version: u8,
    platform: &'static str,
    capabilities: Capabilities,
    /// `None` where the panel is an opaque square window (Linux).
    material: Option<Material>,
}

#[tauri::command]
async fn host_info(app: AppHandle) -> Result<HostInfo, String> {
    let keeper = keeper(&app).ok();
    // The pin probe may run a command (Linux: gsettings): off the IPC thread.
    let pin = match &keeper {
        Some(k) => {
            let k = Arc::clone(k);
            tauri::async_runtime::spawn_blocking(move || k.can_pin()).await.map_err(|e| e.to_string())?
        }
        None => false,
    };
    Ok(HostInfo {
        version: BRIDGE_VERSION,
        platform: if cfg!(target_os = "macos") { "macos" } else { "linux" },
        capabilities: Capabilities {
            notify: true,
            attention: true,
            launch_app: true,
            open_url: true,
            apps: keeper.is_some(),
            pin,
        },
        material: panel::MATERIAL_RADIUS.map(|corner_radius| Material { corner_radius }),
    })
}

/// The device's app keeper — the main instance's tray only.
fn keeper(app: &AppHandle) -> Result<Arc<apps::Keeper>, String> {
    app.try_state::<Arc<apps::Keeper>>()
        .map(|k| Arc::clone(&k))
        .ok_or_else(|| "this helper does not keep the installed apps (not the main instance's tray)".into())
}

/// The installed and pinned apps, after the sync in flight (the panel's
/// load starts one) settles.
#[tauri::command]
async fn apps(app: AppHandle) -> Result<apps::NativeApps, String> {
    let k = keeper(&app)?;
    tauri::async_runtime::spawn_blocking(move || k.apps()).await.map_err(|e| e.to_string())?
}

/// Keep an app in the Dock / GNOME dash (its shim written first when it is
/// not there yet). Resolves once pinned.
#[tauri::command]
async fn pin_app(app: AppHandle, app_id: String) -> Result<(), String> {
    if !shim::valid_app_id(&app_id) {
        return Err(format!("{app_id:?} is not an app id"));
    }
    let k = keeper(&app)?;
    tauri::async_runtime::spawn_blocking(move || k.pin(&app_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_attention(app: AppHandle, on: bool) -> Result<(), String> {
    // None in probe mode, which draws no icon.
    app.try_state::<tray::Icon>().ok_or("no tray icon")?.set_attention(on)
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: Option<String>, tag: Option<String>) -> Result<(), String> {
    let mut n = app.notification().builder().title(title);
    if let Some(body) = body {
        n = n.body(body);
    }
    if let Some(tag) = tag {
        n = n.group(tag);
    }
    n.show().map_err(|e| e.to_string())
}

/// In the default browser. http(s) only — never a `file:` or a custom scheme.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| format!("{url:?}: {e}"))?;
    shim::open_in_browser(&parsed)
}

/// An installed app (its shim): its running window comes forward, else it
/// launches. Rejects `"not-installed"` when there is no shim for it.
#[tauri::command]
async fn launch_app(app_id: String) -> Result<(), String> {
    if !shim::valid_app_id(&app_id) {
        return Err(format!("{app_id:?} is not an app id"));
    }
    tauri::async_runtime::spawn_blocking(move || match shim::find(&app_id) {
        Some(s) => shim::launch(&s, None),
        None => Err("not-installed".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    panel::hide(&app);
}

#[tauri::command]
fn set_panel_height(window: WebviewWindow, px: f64) -> Result<(), String> {
    panel::set_height(&window, px).map(|_| ()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCapabilities {
    /// `start_file_drag`: dragging host paths out as real files.
    file_drag: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    version: u8,
    platform: &'static str,
    capabilities: WindowCapabilities,
}

/// `equinWindow.hostInfo()`: what this app window can do.
#[tauri::command]
fn window_info() -> WindowInfo {
    WindowInfo {
        version: BRIDGE_VERSION,
        platform: if cfg!(target_os = "macos") { "macos" } else { "linux" },
        capabilities: WindowCapabilities { file_drag: file_drag::AVAILABLE },
    }
}

/// `equinWindow.startFileDrag(paths)`: drag host paths out of the window as
/// real files; resolves `"dropped"` / `"cancelled"` once the drag ends.
#[tauri::command]
async fn start_file_drag(window: WebviewWindow, paths: Vec<String>) -> Result<file_drag::Outcome, String> {
    file_drag::start(window, paths).await
}

/// The offline page's Start: start the gateway service, then load the panel.
#[tauri::command]
async fn start_gateway(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(gateway::start)
        .await
        .map_err(|e| e.to_string())??;
    panel::load_remote(&app);
    Ok(())
}

/// Which window is calling, with what it is held to.
pub enum Caller<'a> {
    /// The panel, held to its pin.
    Panel(&'a panel::Pin),
    /// An installed app's window, held to its scope (the app URL's origin).
    AppWindow(&'a window::Scope),
    /// A window no command answers.
    Other,
}

/// May `caller`, showing `shown`, call `command`? The bridge's commands: only
/// the panel on its pinned page (its current URL — after an in-document route
/// change too); `start_gateway`: only the panel on its bundled offline page;
/// an app window's: only an app window on a page of its origin; anything
/// else: no.
pub fn admitted(caller: &Caller, command: &str, shown: &Url) -> Result<(), String> {
    let ok = match caller {
        Caller::Panel(pin) if PANEL_COMMANDS.contains(&command) => pin.admits(shown),
        Caller::Panel(_) if OFFLINE_COMMANDS.contains(&command) => panel::is_offline_page(shown),
        Caller::AppWindow(scope) if APP_WINDOW_COMMANDS.contains(&command) => scope.admits(shown),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!("{command} is not available to {shown}"))
    }
}

/// Every command, behind `admitted`: one gate ahead of the dispatch, not a
/// check each command must remember.
pub fn handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    let dispatch: fn(Invoke) -> bool = tauri::generate_handler![
        host_info,
        set_attention,
        notify,
        open_url,
        launch_app,
        hide_panel,
        set_panel_height,
        apps,
        pin_app,
        window_info,
        start_file_drag,
        start_gateway
    ];
    move |invoke: Invoke| {
        let webview = invoke.message.webview();
        let command = invoke.message.command().to_string();
        let app = webview.app_handle();
        let panel = app.try_state::<panel::Panel>();
        let scope = app.try_state::<window::Scope>();
        let caller = match webview.label() {
            panel::LABEL => panel.as_ref().map_or(Caller::Other, |p| Caller::Panel(p.pin())),
            window::LABEL => scope.as_ref().map_or(Caller::Other, |s| Caller::AppWindow(s)),
            _ => Caller::Other,
        };
        let verdict = match webview.url() {
            Ok(shown) => admitted(&caller, &command, &shown),
            Err(e) => Err(format!("{command}: the calling page's URL is unknown ({e})")),
        };
        match verdict {
            Ok(()) => dispatch(invoke),
            Err(why) => {
                eprintln!("equin-desktop: refused {why}");
                invoke.resolver.reject(why);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_bridge_answers_the_pinned_page_only() {
        let pin = panel::Pin::for_namespace("equin");
        let pin = &Caller::Panel(&pin);
        assert!(admitted(pin, "host_info", &u("http://equin.localhost:9000/home/menu-bar?embed=1")).is_ok());
        assert!(admitted(pin, "notify", &u("http://equin.localhost:9000/home/menu-bar/x")).is_ok());
        assert!(admitted(pin, "pin_app", &u("http://equin.localhost:9000/home/menu-bar?embed=1")).is_ok());
        assert!(admitted(pin, "pin_app", &u("http://other.localhost:9000/home/menu-bar")).is_err());
        assert!(admitted(pin, "apps", &u("http://equin.localhost:9000/agents")).is_err());
        // An in-document route change away from the panel.
        assert!(admitted(pin, "host_info", &u("http://equin.localhost:9000/agents")).is_err());
        assert!(admitted(pin, "host_info", &u("http://equin.localhost:9000/home/menu-barx")).is_err());
        // Another namespace, scheme or port.
        assert!(admitted(pin, "host_info", &u("http://other.localhost:9000/home/menu-bar")).is_err());
        assert!(admitted(pin, "host_info", &u("https://equin.localhost:9000/home/menu-bar")).is_err());
        assert!(admitted(pin, "host_info", &u("http://equin.localhost:9001/home/menu-bar")).is_err());
        // The offline page gets Start only; the panel page never gets Start.
        assert!(admitted(pin, "host_info", &u("tauri://localhost/index.html")).is_err());
        assert!(admitted(pin, "start_gateway", &u("tauri://localhost/index.html")).is_ok());
        assert!(admitted(pin, "start_gateway", &u("http://equin.localhost:9000/home/menu-bar")).is_err());
        // A command outside the table.
        assert!(admitted(pin, "unknown", &u("http://equin.localhost:9000/home/menu-bar")).is_err());
        // The panel never gets an app window's commands.
        assert!(admitted(pin, "start_file_drag", &u("http://equin.localhost:9000/home/menu-bar")).is_err());
    }

    #[test]
    fn an_app_window_answers_its_origin_only() {
        let scope = window::Scope::of(&u("http://equin.localhost:9000/files"));
        let app = &Caller::AppWindow(&scope);
        assert!(admitted(app, "start_file_drag", &u("http://equin.localhost:9000/files/at/x")).is_ok());
        // Anywhere in its namespace: the window roams it.
        assert!(admitted(app, "window_info", &u("http://equin.localhost:9000/agents")).is_ok());
        assert!(admitted(app, "start_file_drag", &u("http://other.localhost:9000/files")).is_err());
        assert!(admitted(app, "start_file_drag", &u("https://example.com/")).is_err());
        // Never the panel's or the offline page's commands.
        assert!(admitted(app, "pin_app", &u("http://equin.localhost:9000/home/menu-bar")).is_err());
        assert!(admitted(app, "start_gateway", &u("tauri://localhost/index.html")).is_err());
        assert!(admitted(&Caller::Other, "window_info", &u("http://equin.localhost:9000/files")).is_err());
    }
}
