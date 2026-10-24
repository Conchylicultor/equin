//! The bridge's commands (`window.equinNative`, src/bridge.js) and the offline
//! page's Start. Each is ACL-gated by capabilities/*.json — the bridge to the
//! panel window on an equin origin, `start_gateway` to the panel's bundled page.

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use url::Url;

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

#[derive(Serialize)]
pub struct HostInfo {
    version: u8,
    platform: &'static str,
    capabilities: Capabilities,
}

#[tauri::command]
fn host_info() -> HostInfo {
    HostInfo {
        version: BRIDGE_VERSION,
        platform: if cfg!(target_os = "macos") { "macos" } else { "linux" },
        capabilities: Capabilities { notify: true, attention: true, launch_app: true, open_url: true },
    }
}

#[tauri::command]
fn set_attention(app: AppHandle, on: bool) -> Result<(), String> {
    app.state::<tray::Icon>().set_attention(on)
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

pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        host_info,
        set_attention,
        notify,
        open_url,
        launch_app,
        hide_panel,
        set_panel_height,
        start_gateway
    ]
}
