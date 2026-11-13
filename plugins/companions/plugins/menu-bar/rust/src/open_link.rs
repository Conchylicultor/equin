//! `equin://open?url=<page>` — a browser tab asking for its page in the
//! installed app's own window. The equin app bundle registers the scheme
//! (`menu-bar/login-services`, `CFBundleURLTypes`), so macOS hands the link to
//! the tray (`RunEvent::Opened`); `equin-desktop open-link <link>` runs the
//! same path from a shell.
//!
//! The grammar mirrors `openLink` in `plugins/companions/plugins/menu-bar/core` — KEEP IN SYNC.
//!
//! Any website can build such a link, so it opens only a page an installed
//! app owns (an equin page): never the default browser, never another scheme.

use url::Url;

use crate::shim;

/// The scheme the bundle registers (`OPEN_LINK_SCHEME` in `menu-bar/core`).
pub const SCHEME: &str = "equin";

/// The page `link` asks to open: `equin://open?url=<http(s) url>`, nothing else.
pub fn parse(link: &Url) -> Result<Url, String> {
    if link.scheme() != SCHEME {
        return Err(format!("{link}: not an {SCHEME}: link"));
    }
    if link.host_str() != Some("open") {
        return Err(format!("{link}: the only {SCHEME}: link is {SCHEME}://open?url=…"));
    }
    let mut pages = link.query_pairs().filter(|(k, _)| k == "url").map(|(_, v)| v.into_owned());
    let raw = pages.next().ok_or_else(|| format!("{link}: no url= parameter"))?;
    if pages.next().is_some() {
        return Err(format!("{link}: url= given twice"));
    }
    let page = Url::parse(&raw).map_err(|e| format!("{link}: url {raw:?}: {e}"))?;
    if page.scheme() != "http" && page.scheme() != "https" {
        return Err(format!("{link}: url {raw:?} must be http(s)"));
    }
    Ok(page)
}

/// What became of a page handed to its owner.
#[derive(Debug)]
pub enum Outcome {
    Opened,
    NoApp,
    Failed { app_id: String, error: String },
}

/// Hand `page` to the installed app owning it — never the default browser
/// (blocking: it reads the shims and waits on `open`).
pub fn open_in_owner(page: &Url) -> Outcome {
    match shim::owner_of(page) {
        None => Outcome::NoApp,
        Some(s) => match shim::launch(&s, Some(page)) {
            Ok(()) => Outcome::Opened,
            Err(error) => Outcome::Failed { app_id: s.app_id, error },
        },
    }
}

impl Outcome {
    /// What to tell the user when the page did not open, `None` when it did.
    pub fn failure(&self, page: &Url) -> Option<String> {
        match self {
            Outcome::Opened => None,
            Outcome::NoApp => Some(format!("No installed equin app opens {page}")),
            Outcome::Failed { app_id, error } => Some(format!("{app_id} could not open {page}: {error}")),
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
    fn reads_the_page() {
        assert_eq!(
            parse(&u("equin://open?url=http%3A%2F%2Fequin.localhost%3A9000%2Ffiles%2Fcomputer%2Fat%2F~%252F__A__"))
                .unwrap()
                .as_str(),
            "http://equin.localhost:9000/files/computer/at/~%2F__A__"
        );
        assert_eq!(
            parse(&u("equin://open?url=https%3A%2F%2Fequin.localhost%3A9000%2Fmail%3Fq%3D1%26x%3D2")).unwrap().as_str(),
            "https://equin.localhost:9000/mail?q=1&x=2"
        );
    }

    #[test]
    fn refuses_anything_else() {
        for bad in [
            "equin://launch?url=http%3A%2F%2Fequin.localhost%3A9000%2F",
            "equin://open",
            "equin://open?url=file%3A%2F%2F%2Fetc%2Fpasswd",
            "equin://open?url=javascript%3Aalert(1)",
            "equin://open?url=not%20a%20url",
            "equin://open?url=http%3A%2F%2Fa%2F&url=http%3A%2F%2Fb%2F",
            "http://open/?url=http%3A%2F%2Fequin.localhost%3A9000%2F",
        ] {
            assert!(parse(&u(bad)).is_err(), "{bad} should be refused");
        }
    }
}
