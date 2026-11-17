//! Compiles the installer page into the binary. The page is TypeScript
//! (`../standalone-page/`), bundled into ONE self-contained HTML file before
//! cargo runs — by the `installer-window` dependency's build
//! (`../deps/internal/window.ts`), which names the file in
//! `EQUIN_INSTALLER_PAGE`. Nothing is fetched at run time.

use std::path::Path;

fn main() {
    println!("cargo:rerun-if-env-changed=EQUIN_INSTALLER_PAGE");
    let page = std::env::var("EQUIN_INSTALLER_PAGE").unwrap_or_else(|_| {
        panic!(
            "EQUIN_INSTALLER_PAGE is not set: the installer page is bundled before cargo runs. \
             Build this crate with `./equin deps install installer-window`, not bare cargo."
        )
    });
    let page = Path::new(&page);
    let html = std::fs::read(page)
        .unwrap_or_else(|e| panic!("cannot read the installer page at {}: {e}", page.display()));
    if !html.starts_with(b"<!doctype html>") {
        panic!("{} is not the bundled installer page", page.display());
    }
    println!("cargo:rerun-if-changed={}", page.display());
    let out = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    std::fs::write(Path::new(&out).join("page.html"), html).expect("write OUT_DIR/page.html");
}
