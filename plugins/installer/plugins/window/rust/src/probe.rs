//! `equin-installer --probe`: can this session show the window?
//!
//! The curl install's stage 0 runs it before choosing the window over the
//! terminal view (install.sh, `choose_view`). It does what the window does
//! up to its first frame — opens a real (hidden) window and webview and loads
//! the page — and exits 0 once the page says it is ready. Anything short of
//! that exits non-zero, which stage 0 reads as "use the terminal":
//!
//! - Linux without webkit2gtk-4.1: the dynamic loader refuses the binary
//!   before `main` (exit 127), so this file never runs at all;
//! - no display, or a session the window server refuses (over ssh, a
//!   sandboxed shell): opening the window or the webview fails;
//! - a webview that never runs the page (a sandbox killing WebKit's helper
//!   processes): the deadline below.
//!
//! Release CI runs it too, as the binaries' smoke test.

use std::time::Duration;

use tao::dpi::LogicalSize;
use tao::event::Event;
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

/// Long enough for a cold WebKit start on a slow machine; a probe that takes
/// longer than this would make a window that is not worth waiting for.
const DEADLINE: Duration = Duration::from_secs(20);

pub fn run() -> ! {
    std::thread::spawn(|| {
        std::thread::sleep(DEADLINE);
        eprintln!("equin-installer: probe: the page did not load within {}s", DEADLINE.as_secs());
        std::process::exit(1);
    });

    #[allow(unused_mut)]
    let mut event_loop = EventLoopBuilder::<()>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        // No Dock icon, no menu bar, no focus taken for a window nobody sees.
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
    }
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("equin installer (probe)")
        .with_inner_size(LogicalSize::new(crate::WIDTH, crate::HEIGHT))
        .with_visible(false)
        .build(&event_loop)
        .unwrap_or_else(|e| fail(&format!("could not open a window: {e}")));
    let webview = WebViewBuilder::new()
        .with_custom_protocol("installer".into(), |_id, request| crate::serve_page(&request))
        .with_ipc_handler(move |request: wry::http::Request<String>| {
            // The page's first message is `ready`, sent once its script ran.
            if request.body().contains("\"ready\"") {
                let _ = proxy.send_event(());
            }
        })
        .with_url("installer://app/");
    #[cfg(target_os = "linux")]
    let webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        webview.build_gtk(window.default_vbox().expect("tao's gtk window has a vbox"))
    };
    #[cfg(not(target_os = "linux"))]
    let webview = webview.build(&window);
    let webview = webview.unwrap_or_else(|e| fail(&format!("could not open the page: {e}")));

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::UserEvent(()) = event {
            let _ = (&window, &webview);
            println!("equin-installer: probe: ok");
            std::process::exit(0);
        }
    });
}

fn fail(why: &str) -> ! {
    eprintln!("equin-installer: probe: {why}");
    std::process::exit(1);
}
