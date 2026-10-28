//! The bridge's commands (`window.equinNative`, src/bridge.js) and the offline
//! page's Start. Each is ACL-gated — the bridge to the panel window on the
//! pinned origin (granted at runtime, `panel::Pin::capability`),
//! `start_gateway` to the panel's bundled page (capabilities/panel-offline.json)
//! — and then gated again here (`handler`) on the page the calling window
//! shows right now, by its row in src/command_table.rs.

use serde::Serialize;
use tauri::ipc::Invoke;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use url::Url;

use crate::command_table::{OFFLINE_COMMANDS, PANEL_COMMANDS};
use crate::{gateway, panel, shim, tray};

/// Bump on a breaking change of the bridge; the web side reads it.
const BRIDGE_VERSION: u8 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    notify: bool,
    attention: bool,
    launch_app: bool,
    open_url: bool,
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
fn host_info() -> HostInfo {
    HostInfo {
        version: BRIDGE_VERSION,
        platform: if cfg!(target_os = "macos") { "macos" } else { "linux" },
        capabilities: Capabilities { notify: true, attention: true, launch_app: true, open_url: true },
        material: panel::MATERIAL_RADIUS.map(|corner_radius| Material { corner_radius }),
    }
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

/// The offline page's Start: start the gateway service, then load the panel.
#[tauri::command]
async fn start_gateway(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(gateway::start)
        .await
        .map_err(|e| e.to_string())??;
    panel::load_remote(&app);
    Ok(())
}

/// May a window showing `shown` call `command`? The bridge's commands: only
/// the pinned panel page (its current URL — after an in-document route change
/// too); `start_gateway`: only the bundled offline page; anything else: no.
pub fn admitted(pin: &panel::Pin, command: &str, shown: &Url) -> Result<(), String> {
    let ok = if PANEL_COMMANDS.contains(&command) {
        pin.admits(shown)
    } else if OFFLINE_COMMANDS.contains(&command) {
        panel::is_offline_page(shown)
    } else {
        false
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
        start_gateway
    ];
    move |invoke: Invoke| {
        let webview = invoke.message.webview();
        let command = invoke.message.command().to_string();
        let verdict = match webview.url() {
            Ok(shown) => admitted(webview.app_handle().state::<panel::Panel>().pin(), &command, &shown),
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
        assert!(admitted(&pin, "host_info", &u("http://equin.localhost:9000/home/menu-bar?embed=1")).is_ok());
        assert!(admitted(&pin, "notify", &u("http://equin.localhost:9000/home/menu-bar/x")).is_ok());
        // An in-document route change away from the panel.
        assert!(admitted(&pin, "host_info", &u("http://equin.localhost:9000/agents")).is_err());
        assert!(admitted(&pin, "host_info", &u("http://equin.localhost:9000/home/menu-barx")).is_err());
        // Another namespace, scheme or port.
        assert!(admitted(&pin, "host_info", &u("http://other.localhost:9000/home/menu-bar")).is_err());
        assert!(admitted(&pin, "host_info", &u("https://equin.localhost:9000/home/menu-bar")).is_err());
        assert!(admitted(&pin, "host_info", &u("http://equin.localhost:9001/home/menu-bar")).is_err());
        // The offline page gets Start only; the panel page never gets Start.
        assert!(admitted(&pin, "host_info", &u("tauri://localhost/index.html")).is_err());
        assert!(admitted(&pin, "start_gateway", &u("tauri://localhost/index.html")).is_ok());
        assert!(admitted(&pin, "start_gateway", &u("http://equin.localhost:9000/home/menu-bar")).is_err());
        // A command outside the table.
        assert!(admitted(&pin, "unknown", &u("http://equin.localhost:9000/home/menu-bar")).is_err());
    }
}
