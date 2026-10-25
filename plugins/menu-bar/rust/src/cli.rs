//! The command line: two modes, each with its own flags. Hand-rolled — the
//! grammar is four flags.

use url::Url;

pub const USAGE: &str = "usage:
  equin-desktop tray [--namespace <ns>]
  equin-desktop window --app <id> --url <url>";

/// The main checkout's namespace (`infra/namespace`'s MAIN_WORKTREE_NAME);
/// `equin.localhost` is only a host alias of it, so the canonical host is used.
pub const MAIN_NAMESPACE: &str = "singularity";

#[derive(Debug, PartialEq)]
pub enum Mode {
    Tray { namespace: String },
    Window { app: String, url: Url },
}

/// A namespace as it may appear as a `.localhost` subdomain.
fn valid_namespace(ns: &str) -> bool {
    !ns.is_empty()
        && ns.len() <= 63
        && ns.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !ns.starts_with('-')
        && !ns.ends_with('-')
}

fn flags(rest: &[String], allowed: &[&str]) -> Result<Vec<(String, String)>, String> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut it = rest.iter();
    while let Some(flag) = it.next() {
        if !allowed.contains(&flag.as_str()) {
            return Err(format!("unknown argument {flag:?}"));
        }
        if out.iter().any(|(f, _)| f == flag) {
            return Err(format!("{flag} given twice"));
        }
        let value = it.next().ok_or_else(|| format!("{flag} needs a value"))?;
        out.push((flag.clone(), value.clone()));
    }
    Ok(out)
}

fn get(flags: &[(String, String)], name: &str) -> Option<String> {
    flags.iter().find(|(f, _)| f == name).map(|(_, v)| v.clone())
}

/// A shim's own launch (macOS: the bundle names the app): LaunchServices may
/// pass a `--url` (`open … --args --url <u>`, a hand-off) and arguments of its
/// own; only a `--url` inside the app's scope is taken, anything else ignored.
pub fn shim_url(args: &[String], base: &Url) -> Url {
    args.iter()
        .position(|a| a == "--url")
        .and_then(|i| args.get(i + 1))
        .and_then(|raw| Url::parse(raw).ok())
        .filter(|u| crate::shim::in_scope(base, u))
        .unwrap_or_else(|| base.clone())
}

pub fn parse(args: &[String]) -> Result<Mode, String> {
    let (mode, rest) = args.split_first().ok_or("no mode given")?;
    match mode.as_str() {
        "tray" => {
            let f = flags(rest, &["--namespace"])?;
            let namespace = get(&f, "--namespace").unwrap_or_else(|| MAIN_NAMESPACE.to_string());
            if !valid_namespace(&namespace) {
                return Err(format!("--namespace {namespace:?} is not a namespace"));
            }
            Ok(Mode::Tray { namespace })
        }
        "window" => {
            let f = flags(rest, &["--app", "--url"])?;
            let app = get(&f, "--app").ok_or("window needs --app <id>")?;
            let raw = get(&f, "--url").ok_or("window needs --url <url>")?;
            let url = Url::parse(&raw).map_err(|e| format!("--url {raw:?}: {e}"))?;
            if url.scheme() != "http" && url.scheme() != "https" {
                return Err(format!("--url {raw:?} must be http(s)"));
            }
            Ok(Mode::Window { app, url })
        }
        other => Err(format!("unknown mode {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn tray_defaults_to_main() {
        assert_eq!(
            parse(&args(&["tray"])),
            Ok(Mode::Tray { namespace: MAIN_NAMESPACE.into() })
        );
        assert_eq!(
            parse(&args(&["tray", "--namespace", "att-1-x"])),
            Ok(Mode::Tray { namespace: "att-1-x".into() })
        );
        assert!(parse(&args(&["tray", "--namespace", "Evil.com"])).is_err());
        assert!(parse(&args(&["tray", "--bogus", "x"])).is_err());
    }

    #[test]
    fn shim_takes_only_an_in_scope_url() {
        let base = Url::parse("http://equin.localhost:9000/mail").unwrap();
        assert_eq!(shim_url(&args(&["-psn_0_1"]), &base), base);
        assert_eq!(
            shim_url(&args(&["--url", "http://equin.localhost:9000/mail/t/1"]), &base).as_str(),
            "http://equin.localhost:9000/mail/t/1"
        );
        assert_eq!(shim_url(&args(&["--url", "https://evil.com/mail"]), &base), base);
    }

    #[test]
    fn window_needs_app_and_url() {
        assert!(parse(&args(&["window", "--app", "mail"])).is_err());
        assert!(parse(&args(&["window", "--app", "mail", "--url", "file:///etc"])).is_err());
        assert!(matches!(
            parse(&args(&["window", "--app", "mail", "--url", "http://equin.localhost:9000/mail"])),
            Ok(Mode::Window { .. })
        ));
    }
}
