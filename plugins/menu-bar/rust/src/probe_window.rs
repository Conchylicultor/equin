//! `equin-desktop probe-window --namespace <ns>`: an app window's scope,
//! checked against the real window (`window::build_window`, its native
//! main-frame gate and burst gate, on WebKit), hidden, with nothing handed to
//! the browser. Once the window's page loads, `src/probe_window.js` is
//! evaluated natively in its main frame; each row tries one way off the
//! namespace, and the probe judges it from what the gate decided, what was
//! handed off and which pages loaded. Prints one JSON line per row and a
//! verdict; exits 0 when every row holds, 1 otherwise. Driven by
//! `menu-bar/e2e/window-probe.ts`.

use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager, WebviewWindow};
use url::Url;

use crate::main_frame::FrameKind;
use crate::window::{self, GateInstalled, Hooks, Launch};

const PROBE_JS: &str = include_str!("probe_window.js");
/// The matrix takes ~30 s; past this the probe fails rather than hangs.
const DEADLINE: Duration = Duration::from_secs(120);
const TITLE_PREFIX: &str = "equin-probe:";
/// Off the namespace, and nowhere: a load the gate lets through fails rather
/// than reaching the network.
const FOREIGN: &str = "https://equin-probe.invalid";
const HOME_MARKER: &str = "equin-probe=home";

#[derive(Default)]
struct Seen {
    started: bool,
    leaving: bool,
    /// (url, main frame, admitted)
    decided: Vec<(String, bool, bool)>,
    handed_off: Vec<String>,
    loaded: Vec<String>,
    rows: Vec<Row>,
}

static SEEN: Mutex<Option<Seen>> = Mutex::new(None);
static SCOPE: Mutex<Option<(Url, String)>> = Mutex::new(None);

fn seen<T>(f: impl FnOnce(&mut Seen) -> T) -> T {
    f(SEEN.lock().unwrap().get_or_insert_with(Seen::default))
}

fn scope() -> (Url, String) {
    SCOPE.lock().unwrap().clone().expect("set before the window")
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
    Row(Row),
    Leaving,
    Error { message: String },
}

fn record_hand_off(url: Url) {
    eprintln!("equin-desktop: probe: would hand {url} off");
    seen(|s| s.handed_off.push(url.to_string()));
}

fn record_decision(url: &Url, frame: FrameKind, admitted: bool) {
    seen(|s| s.decided.push((url.to_string(), frame == FrameKind::Main, admitted)));
}

fn on_loaded(window: &WebviewWindow, url: &Url) {
    let app = window.app_handle();
    seen(|s| s.loaded.push(url.to_string()));
    let (origin, _) = scope();
    if url.origin() != origin.origin() {
        // The window left its namespace: its page (and the probe) is gone.
        return finish(app, Ok(judge(url.as_str())));
    }
    if url.as_str().contains(HOME_MARKER) {
        return finish(app, Ok(judge(url.as_str())));
    }
    if seen(|s| std::mem::replace(&mut s.started, true)) {
        return;
    }
    if !app.state::<GateInstalled>().0.load(Ordering::SeqCst) {
        return finish(app, Err("the page loaded before the main-frame gate was installed".into()));
    }
    let (_, namespace) = scope();
    let mut home = origin.join("/home").expect("a path joins");
    home.set_query(Some(HOME_MARKER));
    let params = json!({
        "foreign": FOREIGN,
        "other": format!("http://{}.localhost:{}", crate::cli::PROBE_OTHER, crate::gateway::PORT),
        "content": format!("http://equin-probe.content.localhost:{}/{namespace}", crate::gateway::PORT),
        "home": home.as_str(),
    });
    let script = PROBE_JS.replace("__EQUIN_PROBE__", &params.to_string());
    if let Err(e) = window.eval(script) {
        finish(app, Err(format!("cannot run the probe in the window: {e}")));
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
        Report::Leaving => seen(|s| s.leaving = true),
        Report::Error { message } => finish(window.app_handle(), Err(format!("the probe script threw: {message}"))),
    }
}

struct Verdict {
    id: String,
    expected: &'static str,
    held: bool,
    detail: String,
}

fn judge(ended_at: &str) -> Vec<Verdict> {
    seen(|s| {
        let mut out = Vec::new();
        let mut push = |id: &str, expected: &'static str, held: bool, detail: String| {
            out.push(Verdict { id: id.into(), expected, held, detail })
        };
        let row = |id: &str| {
            s.rows.iter().find(|r| r.id == id).map(|r| (r.outcome.clone(), r.detail.clone()))
                .unwrap_or(("missing".into(), "no report".into()))
        };
        let refused_main = |marker: &str| s.decided.iter().any(|(u, main, ok)| u.contains(marker) && *main && !ok);
        let handed = |marker: &str| s.handed_off.iter().filter(|u| u.contains(marker)).count();
        let loaded_off = |marker: &str| s.loaded.iter().any(|u| u.contains(marker));

        for (id, marker) in [
            ("link-click", "/link-click"),
            ("location-assign", "/location-assign"),
            ("location-replace", "/location-replace"),
            ("form-post", "/form-post"),
            ("other-namespace", "row=other-namespace"),
        ] {
            let (o, d) = row(id);
            let (r, h, l) = (refused_main(marker), handed(marker), loaded_off(marker));
            push(
                id,
                "refused on the main frame before it loaded, handed off once, page stays",
                o == "stayed" && r && h == 1 && !l,
                format!("{o} at {d}; refused: {r}, handed off: {h}, loaded: {l}"),
            );
        }
        let (o, d) = row("frames");
        let frame_refused = s.decided.iter().any(|(u, _, ok)| u.contains("-frame") && !ok);
        let frame_handed = handed("-frame");
        let frame_seen: Vec<_> = s.decided.iter().filter(|(u, _, _)| u.contains("-frame")).collect();
        push(
            "frames",
            "a content-origin and a foreign frame are admitted (not refused, not handed off), page stays",
            o == "stayed" && !frame_refused && frame_handed == 0,
            format!("{o} at {d}; decisions: {frame_seen:?}"),
        );
        let (o, d) = row("burst");
        let burst = handed("/burst-");
        let tried = s.decided.iter().filter(|(u, main, _)| u.contains("/burst-assign") && *main).count();
        push(
            "burst",
            "30 window.open + 30 location.assign: at most 3 handed off, page stays",
            o == "stayed" && (1..=3).contains(&burst),
            format!("{o} at {d}; handed off: {burst}; assigns the gate saw: {tried}"),
        );
        let (origin, _) = scope();
        let home = Url::parse(ended_at).is_ok_and(|u| u.origin() == origin.origin() && ended_at.contains(HOME_MARKER));
        push(
            "in-namespace",
            "an in-namespace route loads in the window",
            s.leaving && home,
            format!("ended at {ended_at}"),
        );
        let off: Vec<_> = s.loaded.iter().filter(|u| Url::parse(u).map_or(true, |u| u.origin() != origin.origin())).collect();
        push(
            "never-loaded",
            "no page off the namespace ever loaded in the main frame",
            off.is_empty(),
            format!("loaded off the namespace: {off:?}"),
        );
        out
    })
}

fn finish(app: &AppHandle, result: Result<Vec<Verdict>, String>) {
    let code = match result {
        Ok(verdicts) => {
            for v in &verdicts {
                println!("{}", json!({ "row": v.id, "expected": v.expected, "held": v.held, "detail": v.detail }));
            }
            let failed = verdicts.iter().filter(|v| !v.held).count();
            println!(
                "{}",
                json!({ "verdict": if failed == 0 { "held" } else { "broken" }, "rows": verdicts.len(), "failed": failed })
            );
            i32::from(failed > 0)
        }
        Err(e) => {
            println!("{}", json!({ "verdict": "error", "error": e }));
            1
        }
    };
    app.exit(code);
}

pub fn run(namespace: String) {
    let base = Url::parse(&format!("http://{namespace}.localhost:{}/home", crate::gateway::PORT))
        .expect("a namespace makes a URL");
    eprintln!("equin-desktop: window probe on {base}");
    *SCOPE.lock().unwrap() = Some((base.clone(), namespace));
    let launch = Launch { app_id: "equin-probe".into(), name: "equin probe".into(), base: base.clone(), url: base };
    let app = tauri::Builder::default()
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            if !crate::gateway::up() {
                eprintln!("equin-desktop: probe: nothing answers on port {}", crate::gateway::PORT);
                std::process::exit(1);
            }
            let handle: AppHandle = app.handle().clone();
            window::build_window(
                &handle,
                &launch,
                Hooks {
                    hand_off: record_hand_off,
                    decided: Some(record_decision as fn(&Url, FrameKind, bool)),
                    loaded: Some(on_loaded),
                    title: Some(on_title),
                    visible: false,
                },
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
        .expect("equin-desktop: cannot build the window probe");
    app.run(|_, _| {});
}
