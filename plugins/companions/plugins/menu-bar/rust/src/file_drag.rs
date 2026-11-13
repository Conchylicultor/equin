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
//! A file the helper itself may not read never drops anywhere: macOS hands a
//! receiver a dragged file only when the dragging app can read it, and an
//! app's access to the folders macOS protects (Downloads, Documents, Desktop,
//! removable and network volumes) is the user's grant to that app — each
//! installed app's shim is an app of its own. So the drag reads every path
//! first (`readable`): that read is what makes macOS ask the user once per
//! folder (the read waits for the answer, so that first drag ends cancelled —
//! the button is up by then), and a refusal ends the drag as `Denied`, which
//! the page says, instead of a drag every target silently refuses.
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
    /// Not started: macOS does not let this app read a path (a protected
    /// folder the user has not allowed, or has refused), so no target could
    /// take it.
    Denied,
}

/// `EPERM`: what macOS answers a read the user's privacy settings refuse
/// (a plain Unix permission refusal is `EACCES`).
const EPERM: i32 = 1;

/// Whether this process may read every path — asking the user first for a
/// protected folder they have not decided on. Only a privacy refusal counts:
/// any other failure to open (a dangling link) is not the drag's concern.
fn readable(paths: &[String]) -> bool {
    paths.iter().all(|p| match std::fs::File::open(p) {
        Ok(_) => true,
        Err(e) => e.raw_os_error() != Some(EPERM),
    })
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
    let (ok, paths) = tauri::async_runtime::spawn_blocking(move || (readable(&paths), paths))
        .await
        .map_err(|e| e.to_string())?;
    if !ok {
        return Ok(Outcome::Denied);
    }
    platform::start(window, paths).await
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSBezierPath, NSColor, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
        NSDraggingSource, NSEvent, NSEventModifierFlags, NSEventType, NSFont, NSFontAttributeName,
        NSForegroundColorAttributeName, NSImage, NSStringDrawing, NSView, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSPoint, NSRect, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    use tauri::WebviewWindow;

    use super::Outcome;

    /// The drag image, as Finder's list view draws one: per file a row of its
    /// own small icon and its name (logical px), the rows stacked under the
    /// pointer — the first `ROWS` drawn, the rest carried without a picture
    /// (AppKit's count badge says how many).
    const ICON: f64 = 16.0;
    const ROW: f64 = 22.0;
    const PAD: f64 = 4.0;
    const GAP: f64 = 4.0;
    const FONT: f64 = 13.0;
    const ROWS: usize = 5;
    /// A longer name is cut in its middle, as Finder does.
    const NAME_CHARS: usize = 48;

    /// `name`, at most `NAME_CHARS`, its middle elided.
    fn short_name(name: &str) -> String {
        let chars: Vec<char> = name.chars().collect();
        if chars.len() <= NAME_CHARS {
            return name.to_string();
        }
        let keep = NAME_CHARS - 1;
        let head: String = chars[..keep / 2].iter().collect();
        let tail: String = chars[chars.len() - (keep - keep / 2)..].iter().collect();
        format!("{head}…{tail}")
    }

    /// One file's drag row: its icon and name over a rounded backing (the
    /// window's background, so the name reads over any app it crosses).
    fn row_image(icon: Retained<NSImage>, path: &str) -> Retained<NSImage> {
        let name = std::path::Path::new(path)
            .file_name()
            .map_or_else(|| path.to_string(), |n| n.to_string_lossy().into_owned());
        let text = NSString::from_str(&short_name(&name));
        let font = NSFont::systemFontOfSize(FONT);
        let color = NSColor::labelColor();
        let keys = [unsafe { NSFontAttributeName }, unsafe { NSForegroundColorAttributeName }];
        let values: [&AnyObject; 2] = [&font, &color];
        let attrs = NSDictionary::from_slices(&keys, &values);
        // SAFETY: the attributes are a font and a colour under their own keys.
        let text_size = unsafe { text.sizeWithAttributes(Some(&attrs)) };
        let size = NSSize::new(PAD + ICON + GAP + text_size.width.ceil() + PAD * 2.0, ROW);
        let draw = RcBlock::new(move |rect: NSRect| -> Bool {
            let backing = NSColor::windowBackgroundColor().colorWithAlphaComponent(0.85);
            backing.setFill();
            NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(rect, 5.0, 5.0).fill();
            icon.drawInRect(NSRect::new(NSPoint::new(PAD, (ROW - ICON) / 2.0), NSSize::new(ICON, ICON)));
            let at = NSPoint::new(PAD + ICON + GAP, (ROW - text_size.height) / 2.0);
            // SAFETY: as above.
            unsafe { text.drawAtPoint_withAttributes(at, Some(&attrs)) };
            Bool::YES
        });
        NSImage::imageWithSize_flipped_drawingHandler(size, false, &draw)
    }

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
                // Each row under the last (down the screen, whichever way the
                // view counts); past `ROWS`, the last row's place, no picture.
                let shown = i < ROWS;
                let step = ROW * i.min(ROWS - 1) as f64;
                let y = if view.isFlipped() { at.y - ROW / 2.0 + step } else { at.y - ROW / 2.0 - step };
                let origin = NSPoint::new(at.x - PAD - ICON / 2.0, y);
                if shown {
                    let image = row_image(workspace.iconForFile(&ns_path), path);
                    let frame = NSRect::new(origin, image.size());
                    // SAFETY: an NSImage is a valid dragging-frame content.
                    unsafe { item.setDraggingFrame_contents(frame, Some(&*(Retained::as_ptr(&image) as *const AnyObject))) };
                } else {
                    // SAFETY: no contents is valid.
                    unsafe { item.setDraggingFrame_contents(NSRect::new(origin, NSSize::new(ROW, ROW)), None) };
                }
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

    #[test]
    fn a_path_this_process_reads_is_readable() {
        let here = std::env::current_dir().unwrap();
        let file = here.join("Cargo.toml").to_string_lossy().into_owned();
        let dir = here.to_string_lossy().into_owned();
        assert!(readable(&[file, dir]));
        // Not a privacy refusal: not the drag's concern.
        assert!(readable(&["/no/such/equin/path".into()]));
    }

    #[test]
    fn outcomes_serialize_as_the_page_reads_them() {
        let json = |o| serde_json::to_string(&o).unwrap();
        assert_eq!(json(Outcome::Dropped), "\"dropped\"");
        assert_eq!(json(Outcome::Cancelled), "\"cancelled\"");
        assert_eq!(json(Outcome::Denied), "\"denied\"");
    }
}
