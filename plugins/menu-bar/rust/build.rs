//! Renders the spiral icons from `icons/*.svg` (their one source) before
//! tauri-build runs:
//!
//! - `icons/icon.png` (512 px, the app icon) — in the crate dir because
//!   `tauri::generate_context!` requires a default window icon there; it is
//!   gitignored, so it is never an identity input of the build. The deps
//!   barrel's macOS `then` also turns it into the `.app`'s `.icns`.
//! - `$OUT_DIR/tray-{template,light}[-attention].png` — the tray images the
//!   binary compiles in: `template` (black, every colour folded to black: a
//!   macOS template image is alpha only) and `light` (a light spiral and the
//!   accent dot, for a Linux panel, which has no template images).

use std::path::Path;

use resvg::{tiny_skia, usvg};

include!("src/command_table.rs");

fn render(svg: &str, size: u32, out: &Path) {
    let tree = usvg::Tree::from_str(svg, &usvg::Options::default())
        .unwrap_or_else(|e| panic!("icon svg does not parse: {e}"));
    let mut pixmap = tiny_skia::Pixmap::new(size, size).expect("icon size is non-zero");
    let scale = size as f32 / tree.size().width();
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    pixmap
        .save_png(out)
        .unwrap_or_else(|e| panic!("cannot write {}: {e}", out.display()));
}

fn main() {
    let crate_dir = std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let out_dir = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    let icons = Path::new(&crate_dir).join("icons");
    let read = |name: &str| {
        println!("cargo:rerun-if-changed=icons/{name}");
        std::fs::read_to_string(icons.join(name))
            .unwrap_or_else(|e| panic!("cannot read icons/{name}: {e}"))
    };

    // Not a rerun-if-changed path: this script writes it, so cargo would see
    // it newer than the run and rebuild the crate on every build.
    render(&read("app.svg"), 512, &icons.join("icon.png"));

    const ACCENT: &str = "#3b82f6";
    for (name, file) in [("", "tray.svg"), ("-attention", "tray-attention.svg")] {
        let svg = read(file);
        let template = svg.replace("currentColor", "#000000").replace(ACCENT, "#000000");
        let light = svg.replace("currentColor", "#f2f2f2");
        render(&template, 44, &Path::new(&out_dir).join(format!("tray-template{name}.png")));
        render(&light, 48, &Path::new(&out_dir).join(format!("tray-light{name}.png")));
    }

    // An app manifest makes every command ACL-gated: a command runs only for a
    // window and origin a capability grants it to (the panel's, granted at
    // runtime from the pinned URL — src/panel.rs; the offline page's,
    // capabilities/panel-offline.json) — nothing is callable by default.
    println!("cargo:rerun-if-changed=src/command_table.rs");
    let commands: Vec<&'static str> = PANEL_COMMANDS.iter().chain(OFFLINE_COMMANDS).copied().collect();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(Vec::leak(commands))),
    )
    .expect("tauri-build failed");
}
