//! `equin-desktop probe --namespace <ns>`: the bridge's trust boundary,
//! checked against the real panel — the tray's own window, capability and
//! command gate, on WebKit — with no tray icon and nothing handed to the
//! browser. Once the pinned page loads, `src/probe.js` is evaluated natively
//! in its main frame (the stand-in for content that reached the panel); each
//! row of the matrix tries one way to the bridge, and the probe judges it
//! from what the page reports and what the helper saw (refused loads,
//! hand-offs, pages loaded). Prints one JSON line per row and a verdict; exits
//! 0 when every row holds, 1 otherwise. Driven by `menu-bar/e2e/bridge-probe.ts`.

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

use crate::{commands, panel};

const PROBE_JS: &str = include_str!("probe.js");
/// The whole matrix takes ~30 s; past this the probe fails rather than hangs.
const DEADLINE: Duration = Duration::from_secs(120);
const TITLE_PREFIX: &str = "equin-probe:";

#[derive(Default)]
struct Seen {
    started: bool,
    refused: Vec<String>,
    handed_off: Vec<String>,
    loaded_off_pin: Vec<String>,
    rows: Vec<Row>,
}

static SEEN: Mutex<Option<Seen>> = Mutex::new(None);
static OTHER: Mutex<Option<String>> = Mutex::new(None);

fn seen<T>(f: impl FnOnce(&mut Seen) -> T) -> T {
    f(SEEN.lock().unwrap().get_or_insert_with(Seen::default))
}

#[derive(Deserialize, Clone)]
struct Row {
    id: String,
    outcome: String,
    detail: String,
}

#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
enum Report {
    /// One row's outcome.
    Row(Row),
    Stayed { href: String },
    /// The attacker script itself threw.
    Error { message: String },
}

fn record_hand_off(url: &Url) {
    eprintln!("equin-desktop: probe: would hand {url} to the browser");
    seen(|s| s.handed_off.push(url.to_string()));
}

fn record_refused(url: &Url) {
    seen(|s| s.refused.push(url.to_string()));
}

fn new_window_url() -> String {
    "https://equin-probe.invalid/new-window".into()
}

fn on_loaded(window: &WebviewWindow, url: &Url) {
    let app = window.app_handle();
    let pin = app.state::<panel::Panel>().pin().clone();
    if !pin.admits(url) {
        seen(|s| s.loaded_off_pin.push(url.to_string()));
        // The panel was moved: its page (and the probe in it) is gone — judge now.
        if seen(|s| s.started) {
            finish(app, Ok(judge(&pin, url.as_str())));
        }
        return;
    }
    if seen(|s| std::mem::replace(&mut s.started, true)) {
        return;
    }
    let other = OTHER.lock().unwrap().clone().expect("set before the panel");
    let params = json!({
        "otherOrigin": other,
        "sameOrigin": format!("{}/prototypes/__equin_probe__/index.html", pin.origin()),
        "newWindow": new_window_url(),
    });
    let script = PROBE_JS.replace("__EQUIN_PROBE__", &params.to_string());
    if let Err(e) = window.eval(script) {
        finish(app, Err(format!("cannot run the probe in the panel: {e}")));
    }
}

fn on_title(window: &WebviewWindow, title: String) {
    let Some(raw) = title.strip_prefix(TITLE_PREFIX) else { return };
    let report: Report = match serde_json::from_str(raw) {
        Ok(r) => r,
        Err(e) => return finish(window.app_handle(), Err(format!("unreadable probe report {raw:?}: {e}"))),
    };
    match report {
        Report::Row(row) => {
            eprintln!("equin-desktop: probe: {} {}", row.id, row.outcome);
            seen(|s| s.rows.push(row));
        }
        Report::Error { message } => {
            finish(window.app_handle(), Err(format!("the probe script threw: {message}")))
        }
        Report::Stayed { href } => {
            let verdict = judge(window.app_handle().state::<panel::Panel>().pin(), &href);
            finish(window.app_handle(), Ok(verdict));
        }
    }
}

/// One judged row: what was tried, what was expected, whether it held.
struct Verdict {
    id: String,
    expected: &'static str,
    held: bool,
    detail: String,
}

fn judge(pin: &panel::Pin, stayed_at: &str) -> Vec<Verdict> {
    seen(|s| {
        let rows = s.rows.clone();
        let get = |id: &str| rows.iter().find(|r| r.id == id).cloned();
        let refused = |marker: &str| s.refused.iter().any(|u| u.contains(marker));
        let mut out = Vec::new();
        let mut push = |id: &str, expected: &'static str, held: bool, detail: String| {
            out.push(Verdict { id: id.into(), expected, held, detail })
        };
        let row = |id: &str| get(id).map(|r| (r.outcome, r.detail)).unwrap_or(("missing".into(), "no report".into()));

        let (o, d) = row("main-frame");
        push("main-frame", "answered", o == "answered", d);
        for id in ["srcdoc-frame", "same-origin-sandboxed-frame", "opaque-frame"] {
            let (o, d) = row(id);
            push(id, "denied (frame refused or call rejected)", o == "silent" || o == "rejected", d);
        }
        for (id, marker) in [
            ("same-origin-url-frame", "row=iframe"),
            ("object", "row=object"),
            ("embed", "row=embed"),
        ] {
            let (o, d) = row(id);
            push(id, "denied (load refused)", o == "blank" && refused(marker), format!("{o}: {d}"));
        }
        let (o, d) = row("other-namespace-frame");
        push("other-namespace-frame", "denied (load refused)", refused("row=other"), format!("{o}: {d}"));
        let (o, d) = row("pushstate-away");
        push("pushstate-away", "rejected", o == "rejected", d);
        let (o, d) = row("pushstate-back");
        push("pushstate-back", "answered", o == "answered", d);
        let (o, d) = row("window-open");
        let handed = s.handed_off.iter().any(|u| u == &new_window_url());
        push("window-open", "no window; handed to the browser", o == "none" && handed, format!("{o} ({d}); handed off: {handed}"));
        let stayed = Url::parse(stayed_at).is_ok_and(|u| pin.admits(&u));
        push(
            "navigated-panel",
            "denied (panel stays on the pin)",
            stayed && refused("row=navigate") && s.loaded_off_pin.is_empty(),
            format!("at {stayed_at}; loaded off the pin: {:?}", s.loaded_off_pin),
        );
        out
    })
}

fn finish(app: &AppHandle, result: Result<Vec<Verdict>, String>) {
    let code = match result {
        Ok(verdicts) => {
            for v in &verdicts {
                println!(
                    "{}",
                    json!({ "row": v.id, "expected": v.expected, "held": v.held, "detail": v.detail })
                );
            }
            let failed = verdicts.iter().filter(|v| !v.held).count();
            println!("{}", json!({ "verdict": if failed == 0 { "held" } else { "broken" }, "rows": verdicts.len(), "failed": failed }));
            i32::from(failed > 0)
        }
        Err(e) => {
            println!("{}", json!({ "verdict": "error", "error": e }));
            1
        }
    };
    app.exit(code);
}

pub fn run(namespace: String, other: String) {
    eprintln!("equin-desktop: probe mode, panel on {namespace}, elsewhere {other}");
    let other_origin = panel::Pin::for_namespace(&other).origin();
    *OTHER.lock().unwrap() = Some(other_origin);
    let app = tauri::Builder::default()
        .manage(panel::Panel::new(panel::Pin::for_namespace(&namespace), record_hand_off))
        .invoke_handler(commands::handler())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle: AppHandle = app.handle().clone();
            app.add_capability(handle.state::<panel::Panel>().pin().capability())?;
            if !crate::gateway::up() {
                eprintln!("equin-desktop: probe: nothing answers on port {}", crate::gateway::PORT);
                std::process::exit(1);
            }
            panel::create(
                &handle,
                Some(panel::Observer { loaded: on_loaded, refused: record_refused, title: on_title }),
            )?;
            let deadline = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(DEADLINE);
                let target = deadline.clone();
                let _ = deadline.run_on_main_thread(move || {
                    finish(&target, Err(format!("no verdict within {} s", DEADLINE.as_secs())))
                });
            });
            Ok(())
        })
        .build(crate::context())
        .expect("equin-desktop: cannot build the probe");
    app.run(|_, _| {});
}
