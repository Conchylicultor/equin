//! What an app window's main frame may show, and how its hand-offs are paced.
//! Pure: the platform hook (`src/main_frame.rs`) asks `admits_main_frame`
//! before a main-frame load, and every hand-off (a refused load, a new-window
//! request) goes through one `HandOffGate`, so a page cannot flood the default
//! browser.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use url::Url;

use crate::shim;

/// Whether the main frame may load `url`: every page of the window's scope
/// (its namespace's origin), and the non-web documents a page makes of its
/// own (`about:blank`, `blob:`, `data:`), which never leave the window.
pub fn admits_main_frame(scope: &Url, url: &Url) -> bool {
    !web(url) || shim::in_scope(scope, url)
}

pub fn web(url: &Url) -> bool {
    url.scheme() == "http" || url.scheme() == "https"
}

/// The same URL handed off again within this is the same hand-off (a double
/// click, a redirect loop).
const SAME_URL: Duration = Duration::from_secs(2);
/// A burst may hand off this many at once…
const BURST: f64 = 3.0;
/// …then one more per this long.
const REFILL: Duration = Duration::from_secs(3);

#[derive(Debug, PartialEq)]
pub enum Admit {
    Go,
    /// Dropped: part of a burst (or a repeat of the last one).
    Collapsed,
}

/// A token bucket (`BURST`, one back per `REFILL`) plus a same-URL window.
/// Timestamps only — nothing ticks.
pub struct HandOffGate {
    tokens: f64,
    at: Option<Instant>,
    last: Option<(Url, Instant)>,
}

impl HandOffGate {
    pub const fn new() -> Self {
        Self { tokens: BURST, at: None, last: None }
    }

    pub fn admit(&mut self, url: &Url, now: Instant) -> Admit {
        if let Some(at) = self.at {
            let back = now.saturating_duration_since(at).as_secs_f64() / REFILL.as_secs_f64();
            self.tokens = (self.tokens + back).min(BURST);
        }
        self.at = Some(now);
        if self.last.as_ref().is_some_and(|(u, t)| u == url && now.saturating_duration_since(*t) < SAME_URL) {
            return Admit::Collapsed;
        }
        if self.tokens < 1.0 {
            return Admit::Collapsed;
        }
        self.tokens -= 1.0;
        self.last = Some((url.clone(), now));
        Admit::Go
    }
}

static GATE: Mutex<HandOffGate> = Mutex::new(HandOffGate::new());
static COLLAPSED: Mutex<u64> = Mutex::new(0);

/// Hand `url` to `sink` (the installed app owning it, else the browser —
/// `shim::hand_off`; the probe records instead), unless it is part of a burst.
pub fn hand_off(url: Url, sink: fn(Url)) {
    match GATE.lock().unwrap().admit(&url, Instant::now()) {
        Admit::Go => sink(url),
        Admit::Collapsed => {
            let mut n = COLLAPSED.lock().unwrap();
            *n += 1;
            eprintln!("equin-desktop: collapsed the hand-off of {url} ({} collapsed so far)", *n);
        }
    }
}

/// The real sink: on a thread, since it reads the shims from disk and waits on `open`.
pub fn hand_off_to_owner(url: Url) {
    std::thread::spawn(move || shim::hand_off(&url));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn the_main_frame_keeps_to_the_namespace() {
        let scope = u("http://equin.localhost:9000/");
        assert!(admits_main_frame(&scope, &u("http://equin.localhost:9000/mail")));
        assert!(admits_main_frame(&scope, &u("about:blank")));
        assert!(!admits_main_frame(&scope, &u("http://other.localhost:9000/mail")));
        assert!(!admits_main_frame(&scope, &u("http://p1.content.localhost:9000/equin/x")));
        assert!(!admits_main_frame(&scope, &u("https://example.com/")));
    }

    #[test]
    fn a_burst_is_collapsed_to_three() {
        let mut gate = HandOffGate::new();
        let t = Instant::now();
        let admitted =
            (0..60).filter(|i| gate.admit(&u(&format!("https://x.invalid/{i}")), t) == Admit::Go).count();
        assert_eq!(admitted, 3);
        // One back per REFILL.
        assert_eq!(gate.admit(&u("https://x.invalid/a"), t + REFILL), Admit::Go);
        assert_eq!(gate.admit(&u("https://x.invalid/b"), t + REFILL), Admit::Collapsed);
    }

    #[test]
    fn a_repeat_is_one_hand_off() {
        let mut gate = HandOffGate::new();
        let t = Instant::now();
        let url = u("https://example.com/");
        assert_eq!(gate.admit(&url, t), Admit::Go);
        assert_eq!(gate.admit(&url, t + Duration::from_millis(500)), Admit::Collapsed);
        assert_eq!(gate.admit(&url, t + SAME_URL), Admit::Go);
    }

    #[test]
    fn spaced_hand_offs_all_go() {
        let mut gate = HandOffGate::new();
        let t = Instant::now();
        for i in 0..10 {
            assert_eq!(gate.admit(&u(&format!("https://x.invalid/{i}")), t + REFILL * i), Admit::Go);
        }
    }
}
