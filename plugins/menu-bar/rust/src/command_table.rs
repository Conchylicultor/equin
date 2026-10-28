// Every IPC command the helper serves, by the one page allowed to call it —
// the single table build.rs (the ACL's app manifest), the runtime capability
// (panel.rs) and the command gate (commands.rs) all read. `include!`d by
// build.rs, so plain consts only.

/// `window.equinNative` (src/bridge.js): the panel's own page, at the pinned
/// panel URL only.
pub const PANEL_COMMANDS: &[&str] = &[
    "host_info",
    "set_attention",
    "notify",
    "open_url",
    "launch_app",
    "hide_panel",
    "set_panel_height",
];

/// The bundled "equin isn't running" page (local, in the panel window): its
/// Start button.
pub const OFFLINE_COMMANDS: &[&str] = &["start_gateway"];
