//! The Dock icon. A bare executable (this binary, run by install.sh or
//! double-clicked from a download) has no bundle to name an icon, so the Dock
//! shows macOS's generic "exec" square; the app's icon is set at run time
//! instead, from equin's own PNG compiled in.

use objc2::AllocAnyThread;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;

/// equin's app icon — the one the web app serves as its own
/// (framework/web-core's public icon_512x512.png).
const ICON: &[u8] =
    include_bytes!("../../../../../framework/plugins/web-core/web/public/icon_512x512.png");

/// Give the running app equin's icon in the Dock and the app switcher.
/// Called on the main thread before the event loop runs.
pub fn set_icon() {
    let mtm = MainThreadMarker::new().expect("the Dock icon is set from the main thread");
    let data = NSData::with_bytes(ICON);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        // Compiled-in bytes that do not decode are a build fault: say so, run on.
        eprintln!("equin-installer: the compiled-in app icon is not an image; the Dock shows a generic one");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&image)) };
}
