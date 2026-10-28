//! Tray mode: the status icon (macOS NSStatusItem through Tauri's tray; Linux a
//! StatusNotifierItem through ksni), the hidden panel, and the bridge commands.

use tauri::{AppHandle, Manager};

use crate::{commands, panel};

/// The icon's two looks, compiled in from build.rs's renders of icons/*.svg.
#[cfg(target_os = "macos")]
mod images {
    pub const NORMAL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/tray-template.png"));
    pub const ATTENTION: &[u8] =
        include_bytes!(concat!(env!("OUT_DIR"), "/tray-template-attention.png"));
}
#[cfg(target_os = "linux")]
mod images {
    pub const NORMAL: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/tray-light.png"));
    pub const ATTENTION: &[u8] =
        include_bytes!(concat!(env!("OUT_DIR"), "/tray-light-attention.png"));
}

fn image(attention: bool) -> tauri::image::Image<'static> {
    let bytes = if attention { images::ATTENTION } else { images::NORMAL };
    tauri::image::Image::from_bytes(bytes).expect("build.rs renders valid PNGs")
}

#[cfg(target_os = "macos")]
mod platform {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
    use tauri::AppHandle;

    use crate::panel;

    pub struct Icon(TrayIcon);

    pub fn install(app: &AppHandle) -> Result<Icon, String> {
        let tray = TrayIconBuilder::with_id("equin")
            .icon(super::image(false))
            .icon_as_template(true)
            .tooltip("equin")
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    rect,
                    ..
                } = event
                {
                    panel::toggle(tray.app_handle(), Some(rect));
                }
            })
            .build(app)
            .map_err(|e| e.to_string())?;
        Ok(Icon(tray))
    }

    impl Icon {
        pub fn set_attention(&self, on: bool) -> Result<(), String> {
            self.0.set_icon(Some(super::image(on))).map_err(|e| e.to_string())?;
            // set_icon resets the template flag.
            self.0.set_icon_as_template(true).map_err(|e| e.to_string())
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use ksni::blocking::TrayMethods;
    use tauri::AppHandle;

    use crate::panel;

    struct Sni {
        app: AppHandle,
        attention: bool,
        normal: Vec<ksni::Icon>,
        attention_icon: Vec<ksni::Icon>,
    }

    /// RGBA (straight alpha) → the ARGB32, network byte order, SNI carries.
    fn argb(img: &tauri::image::Image<'_>) -> ksni::Icon {
        let mut data = Vec::with_capacity(img.rgba().len());
        for px in img.rgba().chunks_exact(4) {
            data.extend_from_slice(&[px[3], px[0], px[1], px[2]]);
        }
        ksni::Icon { width: img.width() as i32, height: img.height() as i32, data }
    }

    impl ksni::Tray for Sni {
        fn id(&self) -> String {
            "equin".into()
        }
        fn title(&self) -> String {
            "equin".into()
        }
        fn category(&self) -> ksni::Category {
            ksni::Category::ApplicationStatus
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            if self.attention { self.attention_icon.clone() } else { self.normal.clone() }
        }
        /// A left click (`Activate`): the panel, never a menu.
        fn activate(&mut self, _x: i32, _y: i32) {
            let app = self.app.clone();
            let target = app.clone();
            let _ = app.run_on_main_thread(move || panel::toggle(&target, None));
        }
    }

    pub struct Icon(ksni::blocking::Handle<Sni>);

    pub fn install(app: &AppHandle) -> Result<Icon, String> {
        let sni = Sni {
            app: app.clone(),
            attention: false,
            normal: vec![argb(&super::image(false))],
            attention_icon: vec![argb(&super::image(true))],
        };
        // No StatusNotifierWatcher (stock GNOME without the AppIndicator
        // extension) is an error here, not a tray that silently never shows.
        sni.spawn().map(Icon).map_err(|e| format!("tray: unavailable — {e}"))
    }

    impl Icon {
        pub fn set_attention(&self, on: bool) -> Result<(), String> {
            self.0
                .update(|t| t.attention = on)
                .ok_or_else(|| "tray: the StatusNotifierItem service has shut down".to_string())
        }
    }
}

pub use platform::Icon;

pub fn run(namespace: String) {
    eprintln!("equin-desktop: tray mode, namespace {namespace}");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(panel::Panel::new(panel::Pin::for_namespace(&namespace), panel::open_in_browser))
        .invoke_handler(commands::handler())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle: AppHandle = app.handle().clone();
            let icon = match platform::install(&handle) {
                Ok(icon) => icon,
                Err(e) => {
                    eprintln!("equin-desktop: {e}");
                    std::process::exit(1);
                }
            };
            app.manage(icon);
            app.add_capability(handle.state::<panel::Panel>().pin().capability())?;
            panel::create(&handle, None)?;
            eprintln!("equin-desktop: tray ready; panel {}", handle.state::<panel::Panel>().url());
            Ok(())
        })
        .build(crate::context())
        .expect("equin-desktop: cannot build the Tauri app");
    app.run(|_, event| {
        // The panel's hide keeps the app alive: no window is ever "the last".
        if let tauri::RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}
