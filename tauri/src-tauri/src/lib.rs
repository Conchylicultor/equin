//! equin desktop shell.
//!
//! Generic over composition — it holds **no app-specific knowledge**. It reads
//! the app name + port from the bundled `RELEASE.json`, brings up the
//! self-contained stack (gateway + embedded Postgres as detached daemons) via the
//! bundled `launch` binary, points the webview at the local gateway, and tears the
//! stack down on exit via the bundled `teardown` binary.
//!
//! Lifecycle:
//!   setup  → resolve bundle dir + data dir; show placeholder window; off-thread:
//!            run `launch` (unless a prior session's daemons are still up), then
//!            navigate the window to `http://localhost:<port>/`.
//!   exit   → run `teardown` (gateway → PgBouncer → Postgres; data persists).
//!
//! The gateway / Postgres are detached daemons (not this process's children), so
//! pidfile-based teardown — not child-process kill — is the authoritative stop.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;
use tauri::{Manager, RunEvent};

#[derive(Deserialize)]
struct ReleaseManifest {
    composition: String,
    port: u16,
}

/// Everything the exit handler needs to tear the stack down — captured at setup
/// and managed as Tauri state.
struct StackCtx {
    bundle_dir: PathBuf,
    data_dir: PathBuf,
    socket_dir: PathBuf,
    port: u16,
    pg_port: u16,
}

/// Ask the OS for a free loopback TCP port (bind `:0`, read the assignment,
/// release it). The embedded Postgres binds no TCP listener, but its port still
/// names its Unix socket file (`.s.PGSQL.<port>`) and defaults to 5433, the dev
/// cluster's, so each desktop instance still gets its own. This mirrors how the web
/// preview path hands each instance its own `SINGULARITY_PG_PORT`.
fn pick_free_port() -> Option<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
}

fn read_manifest(bundle_dir: &std::path::Path) -> ReleaseManifest {
    let path = bundle_dir.join("RELEASE.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("equin: failed to read {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("equin: invalid RELEASE.json")
}

/// Best-effort liveness probe. The launcher is idempotent and the daemons are
/// detached, so a prior session's stack may still be listening after a crash —
/// in which case we skip bring-up and just reattach the webview.
fn gateway_up(port: u16) -> bool {
    match format!("127.0.0.1:{port}").parse() {
        Ok(addr) => std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok(),
        Err(_) => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Tauri places declared resources under the app's resource dir. The
            // release pipeline stages the self-contained bundle at `resources/bundle`,
            // so it resolves here as `<resource_dir>/bundle`.
            let bundle_dir = app.path().resource_dir()?.join("bundle");
            let manifest = read_manifest(&bundle_dir);
            let port = manifest.port;
            // Free loopback port for the embedded Postgres TCP listener, picked
            // once and reused for teardown so we signal the stack we brought up.
            let pg_port =
                pick_free_port().expect("equin: no free TCP port for embedded Postgres");

            // Data in the OS app-data dir (persistent across launches); PG/PgBouncer
            // sockets on a SHORT /tmp path so the Unix socket path stays under the
            // 104-byte limit even when app-data is a long macOS path.
            let data_dir = app.path().app_data_dir()?.join("data");
            std::fs::create_dir_all(&data_dir).ok();
            // Socket dir must be SHORT: PG/PgBouncer Unix sockets have a 104-byte
            // sun_path limit, and macOS `$TMPDIR` (what `std::env::temp_dir()`
            // returns) is a long `/var/folders/…` path that erodes the budget.
            // `/tmp` keeps `<dir>/equin-<app>/.s.PGSQL.<port>` comfortably under it.
            // Only the ephemeral sockets live here; the cluster data stays in app-data.
            let socket_base = if cfg!(unix) {
                PathBuf::from("/tmp")
            } else {
                std::env::temp_dir()
            };
            let socket_dir = socket_base.join(format!("equin-{}", manifest.composition));
            std::fs::create_dir_all(&socket_dir).ok();

            app.manage(StackCtx {
                bundle_dir: bundle_dir.clone(),
                data_dir: data_dir.clone(),
                socket_dir: socket_dir.clone(),
                port,
                pg_port,
            });

            // Show the placeholder window immediately; bring the stack up off the UI
            // thread (cold first boot runs the full migration set — can take >30s),
            // then navigate to the gateway once `launch` returns ready.
            if let Some(window) = app.get_webview_window("main") {
                window.show().ok();
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if !gateway_up(port) {
                    let status = Command::new(bundle_dir.join("launch"))
                        .env("SINGULARITY_DIR", &data_dir)
                        .env("SINGULARITY_PG_SOCKET_DIR", &socket_dir)
                        // `host:port`; `loopback` binds 127.0.0.1 and [::1]
                        // only — the webview is the one client, on this machine.
                        .env("SINGULARITY_LISTEN", format!("loopback:{port}"))
                        .env("SINGULARITY_PG_PORT", pg_port.to_string())
                        .status();
                    if !matches!(status, Ok(s) if s.success()) {
                        eprintln!("equin: launch failed ({status:?}); app will not load");
                        return;
                    }
                }
                if let Some(w) = handle.get_webview_window("main") {
                    if let Ok(url) = format!("http://localhost:{port}/").parse() {
                        let _ = w.navigate(url);
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("equin: error while building the Tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(ctx) = app.try_state::<StackCtx>() {
                    // Synchronous: hold process exit until the daemons are signalled,
                    // else they outlive the app window.
                    let _ = Command::new(ctx.bundle_dir.join("teardown"))
                        .env("SINGULARITY_DIR", &ctx.data_dir)
                        .env("SINGULARITY_PG_SOCKET_DIR", &ctx.socket_dir)
                        // Same address launch was given, so teardown resolves the
                        // same gateway.
                        .env("SINGULARITY_LISTEN", format!("loopback:{}", ctx.port))
                        .env("SINGULARITY_PG_PORT", ctx.pg_port.to_string())
                        .status();
                }
            }
        });
}
