//! equin-desktop — equin's native helper. Generic: it knows namespaces, URLs
//! and the installed-app shims on disk, never an app.
//!
//! ```text
//! equin-desktop tray [--namespace <ns>]        the menu-bar / top-bar icon and its panel
//! equin-desktop window --app <id> --url <url>  one app's own window (an installed app's process)
//! equin-desktop probe --namespace <ns>         the panel's bridge, attacked and judged (src/probe.rs)
//! ```
//!
//! On macOS the binary is also every installed app's shim executable: inside a
//! bundle whose Info.plist names an equin app (`EquinAppId`), it is that app's
//! window, whatever its arguments.

mod cli;
mod command_table;
mod commands;
mod gateway;
mod instance;
mod panel;
mod probe;
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

/// The app context (config, capabilities, the bundled offline page), generated once.
pub fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}
