//! Installed apps, as the helper sees them: the shims `menu-bar/machine`
//! writes, read back from disk. The shim set IS the installed set — the helper
//! keeps no list of its own, so an app's URL, name and launcher are whatever
//! its shim says.
//!
//! - macOS: `~/Applications/equin <Name>.app` whose `Info.plist` carries
//!   `CFBundleIdentifier dev.equin.app.<id>`, `EquinAppId`, `EquinUrl`.
//! - Linux: `~/.local/share/applications/equin-<id>.desktop` whose `Exec=`
//!   is `<helper> window --app <id> --url <url>`.

use std::path::PathBuf;
use std::process::Command;

use url::Url;

use crate::instance;

/// An installed app: its id, display name, URL (the app's base path on its
/// origin) and where its shim lives.
#[derive(Debug, Clone)]
pub struct Shim {
    pub app_id: String,
    pub name: String,
    pub url: Url,
    /// macOS: the `.app` bundle. Linux: the `.desktop` file.
    pub path: PathBuf,
    /// Linux: the `Exec=` program (the stable helper path).
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub program: Option<String>,
}

/// An app id as the shims spell it (`dev.equin.app.<id>`, `equin-<id>`).
pub fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !id.starts_with('-')
}

pub fn bundle_id(app_id: &str) -> String {
    format!("dev.equin.app.{app_id}")
}

/// The Linux window class / Wayland app id, = the shim's `StartupWMClass`.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn wm_class(app_id: &str) -> String {
    format!("equin-{app_id}")
}

/// The app a URL belongs to, by scope: same origin, and its path at or under
/// the app's base path.
pub fn in_scope(base: &Url, url: &Url) -> bool {
    if url.origin() != base.origin() {
        return false;
    }
    let root = base.path().trim_end_matches('/');
    root.is_empty() || url.path() == root || url.path().starts_with(&format!("{root}/"))
}

/// `url` as the window loads it: chromeless (`?embed=1`).
pub fn embedded(url: &Url) -> Url {
    let mut out = url.clone();
    let rest: Vec<(String, String)> =
        url.query_pairs().filter(|(k, _)| k != "embed").map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    out.set_query(None);
    {
        let mut q = out.query_pairs_mut();
        for (k, v) in &rest {
            q.append_pair(k, v);
        }
        q.append_pair("embed", "1");
    }
    out
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// The installed app owning `url` (the longest base path wins), if any.
pub fn owner_of(url: &Url) -> Option<Shim> {
    installed()
        .into_iter()
        .filter(|s| in_scope(&s.url, url))
        .max_by_key(|s| s.url.path().trim_end_matches('/').len())
}

pub fn find(app_id: &str) -> Option<Shim> {
    installed().into_iter().find(|s| s.app_id == app_id)
}

/// Open `url` in the default browser. http(s) only.
pub fn open_in_browser(url: &Url) -> Result<(), String> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("{url}: only http(s) URLs open"));
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    run(Command::new(opener).arg(url.as_str()))
}

fn run(cmd: &mut Command) -> Result<(), String> {
    let status = cmd.status().map_err(|e| format!("{:?}: {e}", cmd.get_program()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{:?} {:?} failed ({status})", cmd.get_program(), cmd.get_args().collect::<Vec<_>>()))
    }
}

/// Hand `url` (or nothing: just bring it up) to an installed app: its running
/// instance if there is one, else a fresh launch of its shim.
pub fn launch(shim: &Shim, url: Option<&Url>) -> Result<(), String> {
    let url = url.filter(|u| in_scope(&shim.url, u));
    if instance::forward(&shim.app_id, url) {
        // Running: it navigated (and raised itself). On macOS LaunchServices
        // also activates it — a background process cannot take focus itself.
        #[cfg(target_os = "macos")]
        run(Command::new("open").arg(&shim.path))?;
        return Ok(());
    }
    platform::launch(shim, url)
}

/// Hand an out-of-scope URL off: to the installed app owning it, else the
/// default browser.
pub fn hand_off(url: &Url) {
    let result = match owner_of(url) {
        Some(shim) => {
            eprintln!("equin-desktop: {url} belongs to installed app {}", shim.app_id);
            launch(&shim, Some(url))
        }
        None => open_in_browser(url),
    };
    if let Err(e) = result {
        eprintln!("equin-desktop: cannot open {url}: {e}");
    }
}

pub use platform::installed;
#[cfg(target_os = "macos")]
pub use platform::own_bundle;

#[cfg(target_os = "macos")]
mod platform {
    use std::path::Path;
    use std::process::Command;

    use url::Url;

    use super::{bundle_id, home, valid_app_id, Shim};

    fn read_plist(bundle: &Path) -> Option<Shim> {
        let value = plist::Value::from_file(bundle.join("Contents/Info.plist")).ok()?;
        let dict = value.as_dictionary()?;
        let get = |k: &str| dict.get(k).and_then(|v| v.as_string()).map(str::to_string);
        let app_id = get("EquinAppId").filter(|id| valid_app_id(id))?;
        if get("CFBundleIdentifier")? != bundle_id(&app_id) {
            return None;
        }
        let url = Url::parse(&get("EquinUrl")?).ok().filter(|u| u.scheme() == "http" || u.scheme() == "https")?;
        let name = get("CFBundleName").unwrap_or_else(|| app_id.clone());
        Some(Shim { app_id, name, url, path: bundle.to_path_buf(), program: None })
    }

    /// The shim this process runs from: the bundle around the executable
    /// (`<bundle>/Contents/MacOS/equin-desktop`) when its Info.plist names an
    /// equin app. `None` for the helper's own `equin.app` and a bare binary.
    pub fn own_bundle() -> Option<Shim> {
        let exe = std::env::current_exe().ok()?;
        let bundle = exe.parent()?.parent()?.parent()?;
        if bundle.extension().is_some_and(|e| e == "app") {
            read_plist(bundle)
        } else {
            None
        }
    }

    pub fn installed() -> Vec<Shim> {
        let Some(dir) = home().map(|h| h.join("Applications")) else { return Vec::new() };
        let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
        entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("equin ") && n.ends_with(".app"))
            })
            .filter_map(|p| read_plist(&p))
            .collect::<Vec<_>>()
    }

    /// `open` the bundle (LaunchServices: one process per bundle id, its own
    /// Dock icon); a URL rides along as `--url`, which the shim accepts only
    /// inside its own scope.
    pub fn launch(shim: &Shim, url: Option<&Url>) -> Result<(), String> {
        let mut cmd = Command::new("open");
        cmd.arg(&shim.path);
        if let Some(url) = url {
            cmd.args(["--args", "--url", url.as_str()]);
        }
        super::run(&mut cmd)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::Path;
    use std::process::Command;

    use url::Url;

    use super::{home, valid_app_id, wm_class, Shim};

    /// `Exec=` split per the Desktop Entry spec: whitespace-separated, a
    /// double-quoted argument may hold spaces and `\"`, `\\`, `` \` ``, `\$`.
    pub(super) fn exec_args(exec: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur = String::new();
        let mut quoted = false;
        let mut started = false;
        let mut chars = exec.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => {
                    quoted = !quoted;
                    started = true;
                }
                '\\' if quoted => {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                    }
                }
                c if c.is_whitespace() && !quoted => {
                    if started {
                        out.push(std::mem::take(&mut cur));
                        started = false;
                    }
                }
                c => {
                    cur.push(c);
                    started = true;
                }
            }
        }
        if started {
            out.push(cur);
        }
        out
    }

    fn flag(args: &[String], name: &str) -> Option<String> {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
    }

    pub(super) fn read_desktop(path: &Path, text: &str) -> Option<Shim> {
        let mut name = None;
        let mut exec = None;
        let mut in_entry = false;
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
            } else if in_entry {
                if let Some(v) = line.strip_prefix("Name=") {
                    name = Some(v.to_string());
                } else if let Some(v) = line.strip_prefix("Exec=") {
                    exec = Some(v.to_string());
                }
            }
        }
        let args = exec_args(&exec?);
        let app_id = flag(&args, "--app").filter(|id| valid_app_id(id))?;
        let file = path.file_name()?.to_str()?;
        if file != format!("{}.desktop", wm_class(&app_id)) || args.get(1).map(String::as_str) != Some("window") {
            return None;
        }
        let url = Url::parse(&flag(&args, "--url")?).ok().filter(|u| u.scheme() == "http" || u.scheme() == "https")?;
        Some(Shim {
            name: name.unwrap_or_else(|| app_id.clone()),
            app_id,
            url,
            path: path.to_path_buf(),
            program: args.first().cloned(),
        })
    }

    pub fn installed() -> Vec<Shim> {
        let Some(dir) = home().map(|h| h.join(".local/share/applications")) else { return Vec::new() };
        let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
        entries
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("equin-") && n.ends_with(".desktop"))
            })
            .filter_map(|p| read_desktop(&p, &std::fs::read_to_string(&p).ok()?))
            .collect()
    }

    /// No URL: `gtk-launch equin-<id>` (the launcher entry, as the desktop
    /// would). A URL: the entry's own program with that URL (an `Exec=` has no
    /// field code to pass one through).
    pub fn launch(shim: &Shim, url: Option<&Url>) -> Result<(), String> {
        match (url, &shim.program) {
            (Some(url), Some(program)) => {
                Command::new(program)
                    .args(["window", "--app", &shim.app_id, "--url", url.as_str()])
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| format!("{program}: {e}"))
            }
            _ => super::run(Command::new("gtk-launch").arg(wm_class(&shim.app_id))),
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
    fn scope_is_origin_and_base_path() {
        let base = u("http://equin.localhost:9000/mail");
        assert!(in_scope(&base, &u("http://equin.localhost:9000/mail")));
        assert!(in_scope(&base, &u("http://equin.localhost:9000/mail/inbox?x=1")));
        assert!(!in_scope(&base, &u("http://equin.localhost:9000/mailbox")));
        assert!(!in_scope(&base, &u("http://equin.localhost:9000/agents")));
        assert!(!in_scope(&base, &u("http://other.localhost:9000/mail")));
        assert!(!in_scope(&base, &u("https://example.com/mail")));
        let root = u("http://equin.localhost:9000/");
        assert!(in_scope(&root, &u("http://equin.localhost:9000/anything")));
    }

    #[test]
    fn embedded_sets_one_embed_flag() {
        assert_eq!(embedded(&u("http://a.localhost:9000/mail")).as_str(), "http://a.localhost:9000/mail?embed=1");
        assert_eq!(
            embedded(&u("http://a.localhost:9000/mail?q=1&embed=chrome")).as_str(),
            "http://a.localhost:9000/mail?q=1&embed=1"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_a_desktop_entry() {
        let text = "[Desktop Entry]\nType=Application\nName=Mail\nExec=\"/home/u/.singularity/state/menu-bar/equin desktop\" window --app mail --url http://equin.localhost:9000/mail\nStartupWMClass=equin-mail\n";
        let shim = platform::read_desktop(std::path::Path::new("/x/equin-mail.desktop"), text).unwrap();
        assert_eq!(shim.app_id, "mail");
        assert_eq!(shim.name, "Mail");
        assert_eq!(shim.program.as_deref(), Some("/home/u/.singularity/state/menu-bar/equin desktop"));
        assert!(platform::read_desktop(std::path::Path::new("/x/equin-other.desktop"), text).is_none());
    }
}
