//! equin-desktop — equin's native helper. Generic: it knows namespaces, URLs
//! and the installed-app shims on disk, never an app.
//!
//! ```text
//! equin-desktop tray [--namespace <ns>]        the menu-bar / top-bar icon and its panel
//! equin-desktop window --app <id> --url <url>  one app's own window (an installed app's process)
//! equin-desktop probe --namespace <ns>         the panel's bridge, attacked and judged (src/probe.rs)
//! equin-desktop probe-window --namespace <ns>  an app window's scope, tried and judged (src/probe_window.rs)
//! equin-desktop sync-apps --namespace <ns>     install every app of <ns> once, under $HOME (src/apps.rs; verification)
//! ```
//!
//! On macOS the binary is also every installed app's shim executable: inside a
//! bundle whose Info.plist names an equin app (`EquinAppId`), it is that app's
//! window, whatever its arguments.

mod apps;
mod cli;
mod command_table;
mod commands;
mod gateway;
mod instance;
mod main_frame;
mod panel;
mod probe;
mod probe_window;
mod scope_gate;
mod shim;
mod tray;
mod window;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(target_os = "macos")]
    if let Some(own) = shim::own_bundle() {
        let url = cli::shim_url(&args, &own.url);
        return window::run(window::Launch { app_id: own.app_id, name: own.name, base: own.url, url });
    }
    match cli::parse(&args) {
        Ok(cli::Mode::Tray { namespace }) => tray::run(namespace),
        Ok(cli::Mode::Window { app, url }) => window::run(window_launch(app, url)),
        Ok(cli::Mode::Probe { namespace, other }) => probe::run(namespace, other),
        Ok(cli::Mode::ProbeWindow { namespace }) => probe_window::run(namespace),
        Ok(cli::Mode::SyncApps { namespace }) => sync_apps(&namespace),
        Err(message) => {
            eprintln!("equin-desktop: {message}\n\n{}", cli::USAGE);
            std::process::exit(2);
        }
    }
}

/// `window --app <id> --url <url>`: the app's installed shim, when there is one
/// and `url` is inside it, gives the name and the scope; otherwise the URL is
/// its own scope and the id its name.
fn window_launch(app_id: String, url: url::Url) -> window::Launch {
    match shim::find(&app_id).filter(|s| shim::in_scope(&s.url, &url)) {
        Some(s) => window::Launch { app_id, name: s.name, base: s.url, url },
        None => window::Launch { name: app_id.clone(), app_id, base: url.clone(), url },
    }
}

/// One sync of the installed apps against `namespace`'s catalog, under
/// `$HOME` (a scratch home in verification), printed as JSON. The tray's
/// keeper runs the same sync on every panel load.
fn sync_apps(namespace: &str) {
    let origin = panel::Pin::for_namespace(namespace).origin_url();
    let result = (|| {
        let host = apps::Device { origin: origin.clone() };
        let roots = shim::Roots::user().ok_or("$HOME is not set")?;
        let catalog = apps::fetch_catalog(&host)?;
        apps::sync(&host, &roots, &origin, &apps::Helper::current()?, &catalog)
    })();
    match result {
        Ok(report) => println!("{}", serde_json::to_string(&report).expect("a report serializes")),
        Err(e) => {
            eprintln!("equin-desktop: sync-apps: {e}");
            std::process::exit(1);
        }
    }
}

/// The app context (config, capabilities, the bundled offline page), generated once.
pub fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}
