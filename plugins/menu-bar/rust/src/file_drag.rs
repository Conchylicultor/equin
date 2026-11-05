//! An app window's native file drag (`equinWindow.startFileDrag`): the page
//! hands the host paths it is dragging to the OS, which drags them as real
//! files — the drag Finder starts — so any app takes them: Finder, Mail, a
//! browser tab (Google Drive, Photos, …). The page cancels its own HTML drag
//! first; a browser drag can carry no file a page outside the app can read.
//!
//! Outside the app the drag offers COPY only: a drop never moves the user's
//! file away (Finder copies, even on the same volume). Over the app's own
//! window it offers every operation, so the page's own targets (a folder row's
//! move) take it as they take its browser drag. It resolves once the drag ends —
//! dropped somewhere, or cancelled — so the page knows its drag is over (no
//! `dragend` reaches it: the browser drag never started).
//!
//! macOS only (`AVAILABLE`); elsewhere the capability is off and the page
//! keeps its browser drag.

use std::path::Path;

use serde::Serialize;
use tauri::WebviewWindow;

/// Whether this platform drags files natively (`hostInfo().capabilities.fileDrag`).
pub const AVAILABLE: bool = cfg!(target_os = "macos");

/// At most this many paths in one drag.
const MAX_PATHS: usize = 1000;

/// How a drag ended.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// Something took the drop (a copy).
    Dropped,
    /// Released where nothing took it, Esc, or the button was already up.
    Cancelled,
}

/// The paths a page may drag: absolute, existing (a file, a folder, a link),
/// at least one and at most `MAX_PATHS`.
pub fn validate(paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Err("no paths to drag".into());
    }
    if paths.len() > MAX_PATHS {
        return Err(format!("{} paths to drag; at most {MAX_PATHS}", paths.len()));
    }
    for p in paths {
        let path = Path::new(p);
        if !path.is_absolute() {
            return Err(format!("{p:?} is not an absolute path"));
        }
        std::fs::symlink_metadata(path).map_err(|e| format!("{p:?}: {e}"))?;
    }
    Ok(())
}

/// Drag `paths` from `window`'s webview, starting under the pointer.
/// Resolves when the drag ends.
pub async fn start(window: WebviewWindow, paths: Vec<String>) -> Result<Outcome, String> {
    validate(&paths)?;
    platform::start(window, paths).await
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::sync::mpsc;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
        NSEventModifierFlags, NSEventType, NSView, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use tauri::WebviewWindow;

    use super::Outcome;

    /// The drag image: each file's own icon, this big (logical px), the next
    /// ones stacked by `STACK` up to `STACKED` deep.
    const ICON: f64 = 64.0;
    const STACK: f64 = 6.0;
    const STACKED: usize = 4;

    pub struct Ivars {
        ended: RefCell<Option<mpsc::Sender<Outcome>>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        struct FileDragSource;

        unsafe impl NSObjectProtocol for FileDragSource {}

        unsafe impl NSDraggingSource for FileDragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn operation_mask(&self, _session: &NSDraggingSession, context: NSDraggingContext) -> NSDragOperation {
                if context == NSDraggingContext::WithinApplication {
                    NSDragOperation::Copy | NSDragOperation::Move | NSDragOperation::Generic
                } else {
                    NSDragOperation::Copy
                }
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(&self, _session: &NSDraggingSession, _at: NSPoint, operation: NSDragOperation) {
                let outcome = if operation == NSDragOperation::None { Outcome::Cancelled } else { Outcome::Dropped };
                if let Some(tx) = self.ivars().ended.borrow_mut().take() {
                    let _ = tx.send(outcome);
                }
                ACTIVE.with(|a| a.borrow_mut().take());
            }
        }
    );

    thread_local! {
        /// The drag in flight, held until it ends (a session's source is not
        /// guaranteed to be retained by AppKit). One at a time per process.
        static ACTIVE: RefCell<Option<Retained<FileDragSource>>> = const { RefCell::new(None) };
    }

    pub async fn start(window: WebviewWindow, paths: Vec<String>) -> Result<Outcome, String> {
        // The only senders are the closure's (and, once a session runs, its
        // source's): a closure that never runs drops them, so `recv` ends.
        let (tx, rx) = mpsc::channel::<Result<Outcome, String>>();
        window
            .with_webview(move |webview| {
                // SAFETY: on macOS the platform webview's `inner` is its WKWebView.
                let wk: &WKWebView = unsafe { &*webview.inner().cast::<WKWebView>() };
                if let Err(e) = begin(wk, &paths, tx.clone()) {
                    let _ = tx.send(Err(e));
                }
            })
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv().unwrap_or_else(|_| Err("the drag ended without an outcome".into()))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// On the main thread: start the session, or say why not.
    fn begin(wk: &WKWebView, paths: &[String], done: mpsc::Sender<Result<Outcome, String>>) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
        if ACTIVE.with(|a| a.borrow().is_some()) {
            return Err("a file drag is already in progress".into());
        }
        // The page asks from its dragstart, so the button is down; by the time
        // the IPC lands it may be up (a fast flick) — a session started then
        // would follow the pointer with nothing to end it.
        if NSEvent::pressedMouseButtons() & 1 == 0 {
            let _ = done.send(Ok(Outcome::Cancelled));
            return Ok(());
        }
        let webview: &NSView = wk;
        let window = webview.window().ok_or("the webview is in no window")?;
        // From the window's content view, never the webview itself: WebKit
        // reads a drag whose source is its own view as its own page drag, not
        // as files coming in — so the page would not see them as `Files`.
        let view = window.contentView().ok_or("the window has no content view")?;
        let in_window = window.mouseLocationOutsideOfEventStream();
        let at = view.convertPoint_fromView(in_window, None);

        let workspace = NSWorkspace::sharedWorkspace();
        let items: Vec<Retained<NSDraggingItem>> = paths
            .iter()
            .enumerate()
            .map(|(i, path)| {
                let ns_path = NSString::from_str(path);
                let url = NSURL::fileURLWithPath(&ns_path);
                let item = NSDraggingItem::initWithPasteboardWriter(mtm.alloc(), ProtocolObject::from_ref(&*url));
                let icon = workspace.iconForFile(&ns_path);
                let offset = STACK * i.min(STACKED - 1) as f64;
                let frame = NSRect::new(
                    NSPoint::new(at.x - ICON / 2.0 + offset, at.y - ICON / 2.0 + offset),
                    NSSize::new(ICON, ICON),
                );
                // SAFETY: an NSImage is a valid dragging-frame content.
                unsafe { item.setDraggingFrame_contents(frame, Some(&*(Retained::as_ptr(&icon) as *const AnyObject))) };
                item
            })
            .collect();
        let items = NSArray::from_retained_slice(&items);

        // A drag needs a mouse event to start from: the one the pointer is in
        // the middle of, synthesized where it is now.
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            in_window,
            NSEventModifierFlags::empty(),
            0.0,
            window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
        .ok_or("cannot make the drag's mouse event")?;

        let (ended_tx, ended_rx) = mpsc::channel::<Outcome>();
        let source = mtm.alloc::<FileDragSource>().set_ivars(Ivars { ended: RefCell::new(Some(ended_tx)) });
        let source: Retained<FileDragSource> = unsafe { msg_send![super(source), init] };
        ACTIVE.with(|a| *a.borrow_mut() = Some(source.clone()));
        let session = view.beginDraggingSessionWithItems_event_source(&items, &event, ProtocolObject::from_ref(&*source));
        session.setAnimatesToStartingPositionsOnCancelOrFail(true);
        std::thread::spawn(move || {
            let outcome = ended_rx.recv().unwrap_or(Outcome::Cancelled);
            let _ = done.send(Ok(outcome));
        });
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::WebviewWindow;

    use super::Outcome;

    pub async fn start(_window: WebviewWindow, _paths: Vec<String>) -> Result<Outcome, String> {
        Err("a native file drag is not available on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_existing_absolute_paths_drag() {
        let here = std::env::current_dir().unwrap().join("Cargo.toml");
        assert!(validate(&[here.to_string_lossy().into_owned()]).is_ok());
        assert!(validate(&[]).is_err());
        assert!(validate(&["Cargo.toml".into()]).is_err());
        assert!(validate(&["/no/such/equin/path".into()]).is_err());
        assert!(validate(&vec![here.to_string_lossy().into_owned(); MAX_PATHS + 1]).is_err());
    }
}
