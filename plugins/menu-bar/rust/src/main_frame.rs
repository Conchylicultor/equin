//! The main-frame gate of an app window: asks the window, natively and BEFORE
//! the load, whether its main frame may load a URL, and cancels the load when
//! not — without touching any frame's load (an app window frames content
//! origins and foreign sites).
//!
//! Tauri's `on_navigation` cannot do this: wry hands it only the URL, dropping
//! which frame is navigating. The information is native, so this reads it there:
//! - macOS: a per-webview proxy in front of wry's `WKNavigationDelegate`. It
//!   answers `decidePolicyForNavigationAction` from `targetFrame.isMainFrame`
//!   (before the request is sent) and `decidePolicyForNavigationResponse` from
//!   `isForMainFrame` (before a response commits — a server redirect off the
//!   origin), and forwards everything else to wry's delegate unchanged (Tauri's
//!   own navigation handler, page-load events, downloads).
//! - Linux: WebKitGTK names the main frame only on a response decision
//!   (`is_main_frame_main_resource`), so the gate refuses there: the request
//!   went out, but nothing renders and no script of the page runs.

use std::sync::Arc;

use tauri::WebviewWindow;
use url::Url;

/// Which frame a navigation is for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FrameKind {
    Main,
    Sub,
}

/// Admit (`true`) or cancel a load. Called for the main frame and, where the
/// platform says so, a subframe (which the caller should admit).
pub type Decide = Arc<dyn Fn(&Url, FrameKind) -> bool + Send + Sync>;

/// Install the gate on `window`'s webview; `installed` runs once it is in
/// place (on the main thread).
pub fn install(window: &WebviewWindow, decide: Decide, installed: impl FnOnce() + Send + 'static) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        platform::install(&webview, decide);
        installed();
    })
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_web_kit::{
        WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationResponse,
        WKNavigationResponsePolicy, WKWebView,
    };
    use url::Url;

    use super::{Decide, FrameKind};

    pub struct Ivars {
        /// wry's own delegate: everything the gate does not decide goes to it.
        inner: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
        decide: Decide,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        struct MainFrameGate;

        impl MainFrameGate {
            #[unsafe(method(respondsToSelector:))]
            fn responds_to_selector(&self, sel: Sel) -> bool {
                let own: bool = unsafe { msg_send![super(self), respondsToSelector: sel] };
                own || self.ivars().inner.respondsToSelector(sel)
            }

            #[unsafe(method(forwardingTargetForSelector:))]
            fn forwarding_target(&self, _sel: Sel) -> *mut AnyObject {
                Retained::as_ptr(&self.ivars().inner) as *mut AnyObject
            }
        }

        unsafe impl NSObjectProtocol for MainFrameGate {}

        unsafe impl WKNavigationDelegate for MainFrameGate {
            #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
            fn navigation_action(
                &self,
                webview: &WKWebView,
                action: &WKNavigationAction,
                handler: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>,
            ) {
                // No target frame: a new window, which the UI delegate (Tauri's
                // new-window handler) decides.
                let frame = unsafe { action.targetFrame() }
                    .map(|f| if unsafe { f.isMainFrame() } { FrameKind::Main } else { FrameKind::Sub });
                let url = unsafe { action.request().URL() }.and_then(|u| ns_url(&u));
                if let (Some(frame), Some(url)) = (frame, url) {
                    if !(self.ivars().decide)(&url, frame) {
                        return handler.call((WKNavigationActionPolicy::Cancel,));
                    }
                }
                unsafe { self.ivars().inner.webView_decidePolicyForNavigationAction_decisionHandler(webview, action, handler) }
            }

            #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
            fn navigation_response(
                &self,
                webview: &WKWebView,
                response: &WKNavigationResponse,
                handler: &block2::DynBlock<dyn Fn(WKNavigationResponsePolicy)>,
            ) {
                if unsafe { response.isForMainFrame() } {
                    if let Some(url) = unsafe { response.response().URL() }.and_then(|u| ns_url(&u)) {
                        if !(self.ivars().decide)(&url, FrameKind::Main) {
                            return handler.call((WKNavigationResponsePolicy::Cancel,));
                        }
                    }
                }
                unsafe { self.ivars().inner.webView_decidePolicyForNavigationResponse_decisionHandler(webview, response, handler) }
            }
        }
    );

    fn ns_url(url: &objc2_foundation::NSURL) -> Option<Url> {
        Url::parse(&url.absoluteString()?.to_string()).ok()
    }

    thread_local! {
        /// The webview holds its navigation delegate weakly: the gate lives here,
        /// as long as the process (one window per process).
        static GATES: RefCell<Vec<Retained<MainFrameGate>>> = const { RefCell::new(Vec::new()) };
    }

    pub fn install(webview: &tauri::webview::PlatformWebview, decide: Decide) {
        let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
        // SAFETY: on macOS the platform webview's `inner` is its WKWebView.
        let wk: &WKWebView = unsafe { &*webview.inner().cast::<WKWebView>() };
        let inner = unsafe { wk.navigationDelegate() }.expect("wry sets a navigation delegate");
        let gate = mtm.alloc::<MainFrameGate>().set_ivars(Ivars { inner, decide });
        let gate: Retained<MainFrameGate> = unsafe { msg_send![super(gate), init] };
        unsafe { wk.setNavigationDelegate(Some(ProtocolObject::from_ref(&*gate))) };
        GATES.with(|g| g.borrow_mut().push(gate));
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use webkit2gtk::glib::object::Cast;
    use webkit2gtk::{PolicyDecisionExt, PolicyDecisionType, ResponsePolicyDecision, ResponsePolicyDecisionExt, URIResponseExt, WebViewExt};
    use url::Url;

    use super::{Decide, FrameKind};

    pub fn install(webview: &tauri::webview::PlatformWebview, decide: Decide) {
        webview.inner().connect_decide_policy(move |_, decision, kind| {
            if kind != PolicyDecisionType::Response {
                return false;
            }
            let Some(response) = decision.downcast_ref::<ResponsePolicyDecision>() else { return false };
            if !response.is_main_frame_main_resource() {
                return false;
            }
            let Some(url) = response.response().and_then(|r| r.uri()).and_then(|u| Url::parse(&u).ok()) else {
                return false;
            };
            if decide(&url, FrameKind::Main) {
                return false;
            }
            decision.ignore();
            true
        });
    }
}
