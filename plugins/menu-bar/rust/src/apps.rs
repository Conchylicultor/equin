//! Installing and pinning apps — a device power, so the helper's (the device's
//! agent), never the server's. The instance only says which apps exist and
//! what they look like (`GET /api/menu-bar/apps`, menu-bar/machine); the
//! helper writes each one's launcher shim from its OWN executable, keeps the
//! set in step with the catalog, and pins a shim to the Dock / GNOME dash when
//! the panel asks (`pin_app`, through the bridge).
//!
//! Only the tray of the main instance keeps the device's apps (`Keeper`, in
//! tray mode only): a dev tray on another namespace, the probes and a
//! worktree's build never write a shim, so nothing but the installed helper
//! decides what every installed app runs.
//!
//! The shim contract is what src/shim.rs reads back:
//!
//! - macOS — `~/Applications/equin <Name>.app`: `Contents/MacOS/equin-desktop`
//!   (an APFS clone of this executable — the process must live in the shim's
//!   bundle to get its own Dock icon), `Info.plist` (`dev.equin.app.<id>`,
//!   `EquinAppId` / `EquinUrl` / `EquinNamespace` / `EquinShimHash` /
//!   `EquinHelperDigest`, the `localhost` ATS exception, no `LSUIElement`),
//!   `Resources/app.icns` (every iconset size fetched from the instance's icon
//!   route, packed by `iconutil`), ad-hoc signed. Assembled in
//!   `<bundle>.staging` and swapped in whole, so a running app's executable is
//!   never overwritten in place.
//! - Linux — `~/.local/share/applications/equin-<id>.desktop` whose `Exec=`
//!   runs the helper's own stable copy (`~/.local/share/equin/equin-desktop`:
//!   the deps cache it is built into may be swept), and the 512 px icon under
//!   the hicolor theme.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use url::Url;

use crate::shim::{self, Roots, Shim};

/// Where the catalog is served on the instance (menu-bar/core's `getAppCatalog`).
pub const CATALOG_PATH: &str = "/api/menu-bar/apps";

/// The helper's executable name inside a shim bundle / its stable copy.
const EXECUTABLE: &str = "equin-desktop";

/// The `.iconset` members `iconutil` packs into `app.icns`, each with the
/// pixel size it is fetched at (each its own render, never rescaled).
pub const ICONSET: &[(&str, u32)] = &[
    ("icon_16x16", 16),
    ("icon_16x16@2x", 32),
    ("icon_32x32", 32),
    ("icon_32x32@2x", 64),
    ("icon_128x128", 128),
    ("icon_128x128@2x", 256),
    ("icon_256x256", 256),
    ("icon_256x256@2x", 512),
    ("icon_512x512", 512),
    ("icon_512x512@2x", 1024),
];

/// One app of the catalog (menu-bar/core's `CatalogAppSchema`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogApp {
    pub id: String,
    pub name: String,
    pub base_path: String,
    pub hash: String,
    pub icons: Vec<CatalogIcon>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogIcon {
    pub size: u32,
    pub path: String,
}

#[derive(Debug, Deserialize)]
struct Catalog {
    apps: Vec<CatalogApp>,
}

impl CatalogApp {
    fn icon_path(&self, size: u32) -> Result<&str, String> {
        self.icons
            .iter()
            .find(|i| i.size == size)
            .map(|i| i.path.as_str())
            .ok_or_else(|| format!("the catalog has no {size} px icon for {}", self.id))
    }
}

/// Everything installing touches outside the shim files: the commands it runs
/// and the instance it reads. A test fakes both.
pub trait Host {
    /// Run one command; its stdout, or why it failed.
    fn run(&self, argv: &[String]) -> Result<String, String>;
    /// GET an instance-relative path; the body, or why it failed.
    fn fetch(&self, path: &str) -> Result<Vec<u8>, String>;
}

/// This device: real commands, the instance at `origin` over HTTP. The helper
/// sends no browser headers, so the gateway stamps it the owner (a local tool).
pub struct Device {
    pub origin: Url,
}

impl Host for Device {
    fn run(&self, argv: &[String]) -> Result<String, String> {
        let (program, args) = argv.split_first().ok_or("an empty command")?;
        let out = Command::new(program).args(args).output().map_err(|e| format!("{program}: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(format!(
                "{argv:?} failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    fn fetch(&self, path: &str) -> Result<Vec<u8>, String> {
        let url = self.origin.join(path).map_err(|e| format!("{path}: {e}"))?;
        tauri::async_runtime::block_on(async {
            let res = reqwest::get(url.clone()).await.map_err(|e| format!("GET {url}: {e}"))?;
            let status = res.status();
            let body = res.bytes().await.map_err(|e| format!("GET {url}: {e}"))?;
            if status.is_success() {
                Ok(body.to_vec())
            } else {
                Err(format!("GET {url}: {status} {}", String::from_utf8_lossy(&body).trim()))
            }
        })
    }
}

/// The helper executable shims are written from, and its digest — recorded
/// in every shim, so a new helper rewrites them all.
#[derive(Debug, Clone)]
pub struct Helper {
    pub exe: PathBuf,
    pub digest: String,
}

impl Helper {
    /// This process's own executable.
    pub fn current() -> Result<Helper, String> {
        let exe = std::env::current_exe().map_err(|e| format!("this helper's executable: {e}"))?;
        let digest = file_digest(&exe)?;
        Ok(Helper { exe, digest })
    }
}

/// A digest of a file's bytes. It only has to tell two builds apart on one
/// device (a different build — even a different std's hasher — is at worst a
/// rewrite), so the std hasher does.
fn file_digest(path: &Path) -> Result<String, String> {
    use std::hash::{Hash, Hasher};
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    Ok(format!("{:016x}-{}", h.finish(), bytes.len()))
}

/// The bundle's display name, checked (it becomes a path segment): a name
/// with a path separator, a colon (Finder's separator), a control character or
/// a leading dot, or over 64 characters, falls back to the app id.
pub fn safe_name(app: &CatalogApp) -> &str {
    let name = app.name.as_str();
    let ok = !name.trim().is_empty()
        && name.chars().count() <= 64
        && !name.starts_with('.')
        && name.chars().all(|c| !c.is_control() && c != '/' && c != ':' && c != '\\');
    if ok {
        name
    } else {
        &app.id
    }
}

/// The app's absolute URL on this instance: its base path on `origin`.
pub fn app_url(origin: &Url, app: &CatalogApp) -> Result<Url, String> {
    if !app.base_path.starts_with('/') || app.base_path.starts_with("//") {
        return Err(format!("{}: {:?} is not a base path", app.id, app.base_path));
    }
    origin.join(&app.base_path).map_err(|e| format!("{}: {e}", app.id))
}

/// What one sync changed, by app id.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Report {
    pub written: Vec<String>,
    pub removed: Vec<String>,
}

/// Read the catalog from the instance.
pub fn fetch_catalog(host: &dyn Host) -> Result<Vec<CatalogApp>, String> {
    let body = host.fetch(CATALOG_PATH)?;
    let catalog: Catalog =
        serde_json::from_slice(&body).map_err(|e| format!("{CATALOG_PATH} answered an unknown shape: {e}"))?;
    Ok(catalog.apps)
}

/// Bring the shims on disk to exactly `catalog`, each on `origin`, running
/// `helper`:
///
/// - an app with no shim, or whose shim is stale (another fingerprint, helper
///   digest or URL), is (re)written;
/// - a shim under another path than its app's (an app renamed: the macOS
///   bundle is named after the app) is removed once the new one is written;
/// - a shim whose app is not in the catalog is removed.
///
/// Only equin's own shims are touched (src/shim.rs reads `EquinAppId`). A
/// current shim is left alone, so a sync with nothing to do runs no command.
pub fn sync(
    host: &dyn Host,
    roots: &Roots,
    origin: &Url,
    helper: &Helper,
    catalog: &[CatalogApp],
) -> Result<Report, String> {
    let runs = platform::prepare_helper(roots, helper)?;
    let on_disk = shim::installed_in(roots);
    let mut wanted: Vec<&CatalogApp> = Vec::new();
    for app in catalog {
        if shim::valid_app_id(&app.id) {
            wanted.push(app);
        } else {
            eprintln!("equin-desktop: skipped catalog app {:?}: not an app id", app.id);
        }
    }
    let mut report = Report::default();
    for app in &wanted {
        let url = app_url(origin, app)?;
        let path = platform::shim_path(roots, app);
        let fresh = on_disk.iter().any(|s| {
            s.path == path
                && s.app_id == app.id
                && s.url == url
                && s.hash.as_deref() == Some(app.hash.as_str())
                && s.helper_digest.as_deref() == Some(helper.digest.as_str())
        });
        if !fresh {
            platform::write(host, roots, app, &url, helper, &runs)?;
            report.written.push(app.id.clone());
        }
    }
    for s in &on_disk {
        if wanted.iter().any(|a| a.id == s.app_id && platform::shim_path(roots, a) == s.path) {
            continue;
        }
        platform::remove(roots, s)?;
        report.removed.push(s.app_id.clone());
    }
    Ok(report)
}

/// The installed and pinned sets, as the panel reads them (`apps()`).
#[derive(Debug, Serialize)]
pub struct NativeApps {
    pub installed: Vec<String>,
    pub pinned: Vec<String>,
}

fn sorted_ids(shims: &[Shim]) -> Vec<String> {
    let mut ids: Vec<String> = shims.iter().map(|s| s.app_id.clone()).collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Which shims the Dock / dash keeps (none where pinning is not supported).
pub fn read_apps(host: &dyn Host, roots: &Roots) -> Result<NativeApps, String> {
    let shims = shim::installed_in(roots);
    let pinned = if can_pin(host) { platform::pinned(host, &shims)? } else { Vec::new() };
    Ok(NativeApps { installed: sorted_ids(&shims), pinned })
}

/// Can this desktop keep an app pinned? macOS: the Dock, always. Linux: the
/// GNOME dash, when `gsettings get org.gnome.shell favorite-apps` answers (the
/// schema installed, the session bus reachable). Probed once per process.
pub fn can_pin(host: &dyn Host) -> bool {
    static PROBED: OnceLock<bool> = OnceLock::new();
    *PROBED.get_or_init(|| platform::can_pin(host))
}

// --- Pinning, as pure plans --------------------------------------------------

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The `file://` URL the Dock names a bundle by (trailing slash, as it writes them).
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn dock_file_url(bundle: &Path) -> String {
    let href = Url::from_file_path(bundle).map(String::from).unwrap_or_else(|_| bundle.display().to_string());
    if href.ends_with('/') {
        href
    } else {
        format!("{href}/")
    }
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn dock_read_argv() -> Vec<String> {
    ["defaults", "read", "com.apple.dock", "persistent-apps"].map(String::from).to_vec()
}

/// The commands that pin `bundle` given what [`dock_read_argv`] printed — none
/// when it is already there: append one `persistent-apps` tile, then restart
/// the Dock so it rereads its preferences (what `dockutil` does; the Dock has
/// no public API).
#[cfg_attr(target_os = "linux", allow(dead_code))]
pub fn dock_pin_plan(persistent_apps: &str, bundle: &Path) -> Vec<Vec<String>> {
    let url = dock_file_url(bundle);
    if persistent_apps.contains(&url) {
        return Vec::new();
    }
    let tile = format!(
        "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>{}</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>",
        xml_escape(&url)
    );
    vec![
        ["defaults", "write", "com.apple.dock", "persistent-apps", "-array-add"]
            .map(String::from)
            .into_iter()
            .chain([tile])
            .collect(),
        vec!["killall".into(), "Dock".into()],
    ]
}

/// The desktop-file id (and GNOME favorite) of an app's Linux shim.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn desktop_file_id(app_id: &str) -> String {
    format!("{}.desktop", shim::wm_class(app_id))
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn gnome_read_argv() -> Vec<String> {
    ["gsettings", "get", "org.gnome.shell", "favorite-apps"].map(String::from).to_vec()
}

/// A GVariant string array as `gsettings get` prints it — `['a.desktop',
/// 'b.desktop']`, or `@as []` when empty.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn parse_strv(out: &str) -> Result<Vec<String>, String> {
    let text = out.trim();
    let text = text.strip_prefix("@as").map(str::trim_start).unwrap_or(text);
    let inner = text
        .strip_prefix('[')
        .and_then(|t| t.strip_suffix(']'))
        .ok_or_else(|| format!("not a gsettings string array: {out:?}"))?;
    let mut items = Vec::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c != '\'' && c != '"' {
            continue;
        }
        let quote = c;
        let mut item = String::new();
        loop {
            match chars.next() {
                None => return Err(format!("an unterminated string in {out:?}")),
                Some('\\') => {
                    if let Some(n) = chars.next() {
                        item.push(n);
                    }
                }
                Some(c) if c == quote => break,
                Some(c) => item.push(c),
            }
        }
        items.push(item);
    }
    Ok(items)
}

/// A string array as `gsettings set` takes it.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn render_strv(items: &[String]) -> String {
    let quoted: Vec<String> =
        items.iter().map(|i| format!("'{}'", i.replace('\\', "\\\\").replace('\'', "\\'"))).collect();
    format!("[{}]", quoted.join(", "))
}

/// The command that pins an app's desktop entry to the GNOME dash given what
/// [`gnome_read_argv`] printed — none when it is already a favorite.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn gnome_pin_plan(favorites: &str, app_id: &str) -> Result<Vec<Vec<String>>, String> {
    let mut current = parse_strv(favorites)?;
    let id = desktop_file_id(app_id);
    if current.contains(&id) {
        return Ok(Vec::new());
    }
    current.push(id);
    Ok(vec![["gsettings", "set", "org.gnome.shell", "favorite-apps"]
        .map(String::from)
        .into_iter()
        .chain([render_strv(&current)])
        .collect()])
}

/// Pin an installed shim (already pinned: nothing runs).
pub fn pin(host: &dyn Host, shim: &Shim) -> Result<(), String> {
    if !can_pin(host) {
        return Err("Pinning apps is not supported on this desktop.".into());
    }
    for argv in platform::pin_plan(host, shim)? {
        host.run(&argv)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::{Path, PathBuf};

    use plist::{Dictionary, Value};
    use url::Url;

    use super::{dock_file_url, dock_pin_plan, dock_read_argv, safe_name, CatalogApp, Helper, Host, EXECUTABLE, ICONSET};
    use crate::shim::{bundle_id, Roots, Shim};

    /// The executable a shim runs: on macOS each bundle holds its own clone,
    /// so it is this one directly.
    pub fn prepare_helper(_roots: &Roots, helper: &Helper) -> Result<PathBuf, String> {
        Ok(helper.exe.clone())
    }

    pub fn shim_path(roots: &Roots, app: &CatalogApp) -> PathBuf {
        roots.mac_applications().join(format!("equin {}.app", safe_name(app)))
    }

    pub fn info_plist(app: &CatalogApp, url: &Url, helper: &Helper) -> Value {
        let s = |v: &str| Value::String(v.to_string());
        let mut d = Dictionary::new();
        d.insert("CFBundleIdentifier".into(), s(&bundle_id(&app.id)));
        d.insert("CFBundleName".into(), s(safe_name(app)));
        d.insert("CFBundleDisplayName".into(), s(safe_name(app)));
        d.insert("CFBundleExecutable".into(), s(EXECUTABLE));
        d.insert("CFBundleIconFile".into(), s("app"));
        d.insert("CFBundlePackageType".into(), s("APPL"));
        d.insert("CFBundleShortVersionString".into(), s("0.1.0"));
        d.insert("CFBundleVersion".into(), s("1"));
        d.insert("CFBundleInfoDictionaryVersion".into(), s("6.0"));
        d.insert("LSMinimumSystemVersion".into(), s("11.0"));
        d.insert("NSHighResolutionCapable".into(), Value::Boolean(true));
        d.insert("EquinAppId".into(), s(&app.id));
        d.insert("EquinUrl".into(), s(url.as_str()));
        d.insert("EquinNamespace".into(), s(url.host_str().and_then(|h| h.strip_suffix(".localhost")).unwrap_or("")));
        d.insert("EquinShimHash".into(), s(&app.hash));
        d.insert("EquinHelperDigest".into(), s(&helper.digest));
        // Without it the bundle's WKWebView never loads http://*.localhost
        // (`NSAllowsLocalNetworking` does not cover it).
        let mut localhost = Dictionary::new();
        localhost.insert("NSIncludesSubdomains".into(), Value::Boolean(true));
        localhost.insert("NSExceptionAllowsInsecureHTTPLoads".into(), Value::Boolean(true));
        let mut domains = Dictionary::new();
        domains.insert("localhost".into(), Value::Dictionary(localhost));
        let mut ats = Dictionary::new();
        ats.insert("NSExceptionDomains".into(), Value::Dictionary(domains));
        d.insert("NSAppTransportSecurity".into(), Value::Dictionary(ats));
        Value::Dictionary(d)
    }

    fn arg(p: &Path) -> String {
        p.display().to_string()
    }

    pub fn write(
        host: &dyn Host,
        roots: &Roots,
        app: &CatalogApp,
        url: &Url,
        helper: &Helper,
        runs: &Path,
    ) -> Result<(), String> {
        let bundle = shim_path(roots, app);
        let staging = PathBuf::from(format!("{}.staging", bundle.display()));
        let io = |e: std::io::Error| format!("{}: {e}", staging.display());
        std::fs::create_dir_all(roots.mac_applications()).map_err(io)?;
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(io)?;
        }
        let assemble = || -> Result<(), String> {
            let contents = staging.join("Contents");
            std::fs::create_dir_all(contents.join("MacOS")).map_err(io)?;
            std::fs::create_dir_all(contents.join("Resources")).map_err(io)?;
            host.run(&["cp".into(), "-c".into(), arg(runs), arg(&contents.join("MacOS").join(EXECUTABLE))])?;
            info_plist(app, url, helper).to_file_xml(contents.join("Info.plist")).map_err(|e| e.to_string())?;
            write_icns(host, app, &contents.join("Resources").join("app.icns"))?;
            host.run(&["codesign".into(), "--force".into(), "--sign".into(), "-".into(), arg(&staging)])?;
            if bundle.exists() {
                std::fs::remove_dir_all(&bundle).map_err(|e| format!("{}: {e}", bundle.display()))?;
            }
            std::fs::rename(&staging, &bundle).map_err(io)
        };
        let result = assemble();
        if result.is_err() && staging.exists() {
            if let Err(e) = std::fs::remove_dir_all(&staging) {
                eprintln!("equin-desktop: cannot remove {}: {e}", staging.display());
            }
        }
        result
    }

    fn write_icns(host: &dyn Host, app: &CatalogApp, icns: &Path) -> Result<(), String> {
        // Scratch, outside the bundle — unique per write (another process may
        // write the same app's icon at once: a `sync-apps` beside the tray).
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let scratch =
            std::env::temp_dir().join(format!("equin-shim-icon-{}-{}-{n}", app.id, std::process::id()));
        let iconset = scratch.join("app.iconset");
        let io = |e: std::io::Error| format!("{}: {e}", scratch.display());
        std::fs::create_dir_all(&iconset).map_err(io)?;
        let result = (|| {
            for (name, px) in ICONSET {
                let png = host.fetch(app.icon_path(*px)?)?;
                std::fs::write(iconset.join(format!("{name}.png")), png).map_err(io)?;
            }
            host.run(&["iconutil".into(), "-c".into(), "icns".into(), arg(&iconset), "-o".into(), arg(icns)])
                .map(|_| ())
        })();
        if let Err(e) = std::fs::remove_dir_all(&scratch) {
            eprintln!("equin-desktop: cannot remove {}: {e}", scratch.display());
        }
        result
    }

    pub fn remove(_roots: &Roots, shim: &Shim) -> Result<(), String> {
        std::fs::remove_dir_all(&shim.path).map_err(|e| format!("{}: {e}", shim.path.display()))
    }

    pub fn can_pin(_host: &dyn Host) -> bool {
        true
    }

    pub fn pin_plan(host: &dyn Host, shim: &Shim) -> Result<Vec<Vec<String>>, String> {
        Ok(dock_pin_plan(&host.run(&dock_read_argv())?, &shim.path))
    }

    pub fn pinned(host: &dyn Host, shims: &[Shim]) -> Result<Vec<String>, String> {
        let apps = host.run(&dock_read_argv())?;
        let mut ids: Vec<String> =
            shims.iter().filter(|s| apps.contains(&dock_file_url(&s.path))).map(|s| s.app_id.clone()).collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::{Path, PathBuf};

    use url::Url;

    use super::{desktop_file_id, gnome_pin_plan, gnome_read_argv, parse_strv, safe_name, CatalogApp, Helper, Host, EXECUTABLE};
    use crate::shim::{wm_class, Roots, Shim};

    /// The helper's own stable copy, which every desktop entry runs: the deps
    /// cache it was built into may be swept. Re-copied (beside, then renamed
    /// over — a running app keeps its old inode) when the digest differs.
    pub fn prepare_helper(roots: &Roots, helper: &Helper) -> Result<PathBuf, String> {
        let dir = roots.xdg_data_home().join("equin");
        let binary = dir.join(EXECUTABLE);
        let digest_file = dir.join(format!("{EXECUTABLE}.digest"));
        let io = |e: std::io::Error| format!("{}: {e}", dir.display());
        let recorded = std::fs::read_to_string(&digest_file).ok();
        if recorded.as_deref().map(str::trim) == Some(helper.digest.as_str()) && binary.exists() {
            return Ok(binary);
        }
        std::fs::create_dir_all(&dir).map_err(io)?;
        let tmp = dir.join(format!("{EXECUTABLE}.tmp"));
        std::fs::copy(&helper.exe, &tmp).map_err(io)?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).map_err(io)?;
        }
        std::fs::rename(&tmp, &binary).map_err(io)?;
        std::fs::write(&digest_file, format!("{}\n", helper.digest)).map_err(io)?;
        Ok(binary)
    }

    pub fn shim_path(roots: &Roots, app: &CatalogApp) -> PathBuf {
        roots.shim_dir().join(desktop_file_id(&app.id))
    }

    fn icon_path(roots: &Roots, app_id: &str) -> PathBuf {
        roots.xdg_data_home().join("icons/hicolor/512x512/apps").join(format!("{}.png", wm_class(app_id)))
    }

    /// A desktop-entry value: newlines escaped, per the freedesktop spec.
    fn value(v: &str) -> String {
        v.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t")
    }

    /// One `Exec=` argument, quoted when it needs to be.
    fn exec_arg(a: &str) -> String {
        if !a.is_empty() && a.bytes().all(|b| b.is_ascii_alphanumeric() || b"_@%+=:,./-".contains(&b)) {
            return a.to_string();
        }
        let mut out = String::from("\"");
        for c in a.chars() {
            if matches!(c, '"' | '`' | '$' | '\\') {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('"');
        out
    }

    pub fn desktop_file(app: &CatalogApp, url: &Url, helper: &Helper, runs: &Path) -> String {
        let name = safe_name(app);
        let exec = [runs.display().to_string(), "window".into(), "--app".into(), app.id.clone(), "--url".into(), url.to_string()]
            .iter()
            .map(|a| exec_arg(a))
            .collect::<Vec<_>>()
            .join(" ");
        let class = wm_class(&app.id);
        format!(
            "[Desktop Entry]\nType=Application\nVersion=1.0\nName={}\nComment={}\nExec={}\nIcon={class}\nStartupWMClass={class}\nTerminal=false\nCategories=Utility;\nX-Equin-AppId={}\nX-Equin-Url={}\nX-Equin-ShimHash={}\nX-Equin-HelperDigest={}\n",
            value(name),
            value(&format!("{name} — an equin app")),
            value(&exec),
            app.id,
            value(url.as_str()),
            app.hash,
            helper.digest,
        )
    }

    fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
        let io = |e: std::io::Error| format!("{}: {e}", path.display());
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(io)?;
        }
        let tmp = PathBuf::from(format!("{}.tmp", path.display()));
        std::fs::write(&tmp, data).map_err(io)?;
        std::fs::rename(&tmp, path).map_err(io)
    }

    /// The icon first, then the entry — so the launcher never names a missing icon.
    pub fn write(
        host: &dyn Host,
        roots: &Roots,
        app: &CatalogApp,
        url: &Url,
        helper: &Helper,
        runs: &Path,
    ) -> Result<(), String> {
        let png = host.fetch(app.icon_path(512)?)?;
        write_atomic(&icon_path(roots, &app.id), &png)?;
        write_atomic(&shim_path(roots, app), desktop_file(app, url, helper, runs).as_bytes())
    }

    pub fn remove(roots: &Roots, shim: &Shim) -> Result<(), String> {
        std::fs::remove_file(&shim.path).map_err(|e| format!("{}: {e}", shim.path.display()))?;
        let icon = icon_path(roots, &shim.app_id);
        if icon.exists() {
            std::fs::remove_file(&icon).map_err(|e| format!("{}: {e}", icon.display()))?;
        }
        Ok(())
    }

    pub fn can_pin(host: &dyn Host) -> bool {
        host.run(&gnome_read_argv()).is_ok()
    }

    pub fn pin_plan(host: &dyn Host, shim: &Shim) -> Result<Vec<Vec<String>>, String> {
        gnome_pin_plan(&host.run(&gnome_read_argv())?, &shim.app_id)
    }

    pub fn pinned(host: &dyn Host, shims: &[Shim]) -> Result<Vec<String>, String> {
        let favorites = parse_strv(&host.run(&gnome_read_argv())?)?;
        let mut ids: Vec<String> =
            shims.iter().filter(|s| favorites.contains(&desktop_file_id(&s.app_id))).map(|s| s.app_id.clone()).collect();
        ids.sort();
        ids.dedup();
        Ok(ids)
    }
}

// --- The tray's keeper -------------------------------------------------------

#[derive(Default)]
struct State {
    /// A sync was asked for and has not started yet.
    pending: bool,
    /// A sync or a pin is running.
    running: bool,
    /// The last sync's failure, until one succeeds.
    error: Option<String>,
}

/// The device's installed apps, kept by the main instance's tray: one sync or
/// pin at a time; a read waits for the one in flight, so the panel's first
/// `apps()` answers after its own load's sync.
pub struct Keeper {
    origin: Url,
    state: Mutex<State>,
    settled: Condvar,
}

impl Keeper {
    pub fn new(origin: Url) -> Arc<Keeper> {
        Arc::new(Keeper { origin, state: Mutex::default(), settled: Condvar::new() })
    }

    fn host(&self) -> Device {
        Device { origin: self.origin.clone() }
    }

    fn roots() -> Result<Roots, String> {
        Roots::user().ok_or_else(|| "$HOME is not set".to_string())
    }

    /// The panel page started loading (tray start, a reload onto a new web
    /// bundle — which is what a changed app set is): sync once it can. Marked
    /// pending synchronously, before the page's scripts run, so the page's
    /// first `apps()` waits for it.
    pub fn begin_sync(self: &Arc<Self>) {
        let mut st = self.state.lock().unwrap();
        st.pending = true;
        if st.running {
            return; // The running worker picks it up.
        }
        st.running = true;
        drop(st);
        let keeper = Arc::clone(self);
        std::thread::spawn(move || keeper.drain());
    }

    fn drain(&self) {
        loop {
            {
                let mut st = self.state.lock().unwrap();
                if !st.pending {
                    st.running = false;
                    self.settled.notify_all();
                    return;
                }
                st.pending = false;
            }
            let result = self.sync_now();
            let mut st = self.state.lock().unwrap();
            match result {
                Ok(r) => {
                    if !r.written.is_empty() || !r.removed.is_empty() {
                        eprintln!("equin-desktop: apps synced — written {:?}, removed {:?}", r.written, r.removed);
                    }
                    st.error = None;
                }
                Err(e) => {
                    eprintln!("equin-desktop: syncing the installed apps failed: {e}");
                    st.error = Some(e);
                }
            }
        }
    }

    fn sync_now(&self) -> Result<Report, String> {
        let host = self.host();
        let catalog = fetch_catalog(&host)?;
        sync(&host, &Self::roots()?, &self.origin, &Helper::current()?, &catalog)
    }

    /// Run `work` exclusively, after any sync in flight.
    fn exclusive<T>(&self, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut st = self.state.lock().unwrap();
        while st.pending || st.running {
            st = self.settled.wait(st).unwrap();
        }
        if let Some(e) = &st.error {
            return Err(format!("syncing the installed apps failed: {e}"));
        }
        st.running = true;
        drop(st);
        let result = work();
        let mut st = self.state.lock().unwrap();
        st.running = false;
        self.settled.notify_all();
        result
    }

    /// Can this desktop keep an app pinned (probed once)?
    pub fn can_pin(&self) -> bool {
        can_pin(&self.host())
    }

    /// The installed and pinned sets, once the sync in flight settled; a
    /// failed sync is the answer's failure.
    pub fn apps(&self) -> Result<NativeApps, String> {
        self.exclusive(|| read_apps(&self.host(), &Self::roots()?))
    }

    /// Pin an app to the Dock / dash — writing its shim first when it is not
    /// there yet (the sync has normally written it).
    pub fn pin(&self, app_id: &str) -> Result<(), String> {
        self.exclusive(|| {
            let host = self.host();
            let roots = Self::roots()?;
            let find = || shim::installed_in(&roots).into_iter().find(|s| s.app_id == app_id);
            let shim = match find() {
                Some(s) => s,
                None => {
                    let catalog = fetch_catalog(&host)?;
                    if !catalog.iter().any(|a| a.id == app_id) {
                        return Err(format!("{app_id:?} is not an installable app"));
                    }
                    sync(&host, &roots, &self.origin, &Helper::current()?, &catalog)?;
                    find().ok_or_else(|| format!("{app_id}: its shim was not written"))?
                }
            };
            pin(&host, &shim)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// A fake device: records every command, answers `cp` / `iconutil` /
    /// `codesign` by touching the files they would make, and a Dock/dash read
    /// from `pinned`.
    struct Fake {
        commands: RefCell<Vec<Vec<String>>>,
        fetched: RefCell<Vec<String>>,
        pinned: RefCell<String>,
        fail: Option<&'static str>,
    }

    impl Fake {
        fn new() -> Fake {
            let empty = if cfg!(target_os = "macos") { "(\n)" } else { "@as []" };
            Fake { commands: RefCell::default(), fetched: RefCell::default(), pinned: RefCell::new(empty.into()), fail: None }
        }
        fn programs(&self) -> Vec<String> {
            self.commands.borrow().iter().map(|c| c[0].clone()).collect()
        }
    }

    impl Host for Fake {
        fn run(&self, argv: &[String]) -> Result<String, String> {
            self.commands.borrow_mut().push(argv.to_vec());
            if Some(argv[0].as_str()) == self.fail {
                return Err(format!("{} failed", argv[0]));
            }
            match argv[0].as_str() {
                "cp" => std::fs::write(&argv[3], b"helper").map(|_| String::new()).map_err(|e| e.to_string()),
                "iconutil" => std::fs::write(&argv[5], b"icns").map(|_| String::new()).map_err(|e| e.to_string()),
                "defaults" if argv[1] == "read" => Ok(self.pinned.borrow().clone()),
                "gsettings" if argv[1] == "get" => Ok(self.pinned.borrow().clone()),
                "defaults" => {
                    self.pinned.borrow_mut().push_str(&argv[5]);
                    Ok(String::new())
                }
                "gsettings" => {
                    *self.pinned.borrow_mut() = argv[4].clone();
                    Ok(String::new())
                }
                _ => Ok(String::new()),
            }
        }
        fn fetch(&self, path: &str) -> Result<Vec<u8>, String> {
            self.fetched.borrow_mut().push(path.to_string());
            Ok(b"\x89PNG".to_vec())
        }
    }

    fn app(id: &str, name: &str, hash: &str) -> CatalogApp {
        let sizes = [16, 32, 64, 128, 192, 256, 512, 1024];
        CatalogApp {
            id: id.into(),
            name: name.into(),
            base_path: format!("/{id}"),
            hash: hash.into(),
            icons: sizes
                .iter()
                .map(|s| CatalogIcon { size: *s, path: format!("/api/apps/{id}/icon/{s}.png") })
                .collect(),
        }
    }

    fn home() -> (Roots, PathBuf) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "equin-apps-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A stand-in for this helper's executable.
        let exe = dir.join("built-helper");
        std::fs::write(&exe, b"helper v1").unwrap();
        (Roots { home: dir }, exe)
    }

    fn helper(exe: &Path, digest: &str) -> Helper {
        Helper { exe: exe.to_path_buf(), digest: digest.into() }
    }

    fn origin() -> Url {
        Url::parse("http://main.localhost:9000").unwrap()
    }

    fn ids(roots: &Roots) -> Vec<String> {
        sorted_ids(&shim::installed_in(roots))
    }

    #[test]
    fn writes_a_shim_per_app_then_nothing_while_current() {
        let (roots, exe) = home();
        let host = Fake::new();
        let catalog = [app("mail", "Mail", "h1"), app("pages", "Pages", "h1")];
        let r = sync(&host, &roots, &origin(), &helper(&exe, "d1"), &catalog).unwrap();
        assert_eq!(r.written, vec!["mail", "pages"]);
        assert_eq!(ids(&roots), vec!["mail", "pages"]);
        let mail = shim::installed_in(&roots).into_iter().find(|s| s.app_id == "mail").unwrap();
        assert_eq!(mail.url.as_str(), "http://main.localhost:9000/mail");
        assert_eq!(mail.hash.as_deref(), Some("h1"));
        assert_eq!(mail.helper_digest.as_deref(), Some("d1"));

        let before = host.commands.borrow().len();
        let fetched = host.fetched.borrow().len();
        let again = sync(&host, &roots, &origin(), &helper(&exe, "d1"), &catalog).unwrap();
        assert_eq!(again, Report::default());
        assert_eq!(host.commands.borrow().len(), before, "a current shim runs no command");
        assert_eq!(host.fetched.borrow().len(), fetched, "nor fetches an icon");
    }

    #[test]
    fn rewrites_a_stale_shim_a_new_helper_or_another_origin() {
        let (roots, exe) = home();
        let host = Fake::new();
        sync(&host, &roots, &origin(), &helper(&exe, "d1"), &[app("mail", "Mail", "h1")]).unwrap();
        let changed = sync(&host, &roots, &origin(), &helper(&exe, "d1"), &[app("mail", "Mail", "h2")]).unwrap();
        assert_eq!(changed.written, vec!["mail"]);
        let new_helper = sync(&host, &roots, &origin(), &helper(&exe, "d2"), &[app("mail", "Mail", "h2")]).unwrap();
        assert_eq!(new_helper.written, vec!["mail"]);
        let elsewhere = Url::parse("http://other.localhost:9000").unwrap();
        let moved = sync(&host, &roots, &elsewhere, &helper(&exe, "d2"), &[app("mail", "Mail", "h2")]).unwrap();
        assert_eq!(moved.written, vec!["mail"]);
    }

    #[test]
    fn removes_a_renamed_apps_old_shim_and_a_gone_apps() {
        let (roots, exe) = home();
        let host = Fake::new();
        sync(&host, &roots, &origin(), &helper(&exe, "d1"), &[app("mail", "Mail", "h1"), app("pages", "Pages", "h1")])
            .unwrap();
        let r = sync(&host, &roots, &origin(), &helper(&exe, "d1"), &[app("mail", "Post", "h2")]).unwrap();
        assert_eq!(r.written, vec!["mail"]);
        assert_eq!(ids(&roots), vec!["mail"]);
        if cfg!(target_os = "macos") {
            // The renamed app's old bundle is gone, the new one is there.
            assert!(!roots.mac_applications().join("equin Mail.app").exists());
            assert!(roots.mac_applications().join("equin Post.app").exists());
            assert_eq!(r.removed, vec!["mail", "pages"]);
        } else {
            assert_eq!(r.removed, vec!["pages"]);
        }
    }

    #[test]
    fn leaves_what_is_not_an_equin_shim() {
        let (roots, exe) = home();
        let host = Fake::new();
        let foreign = roots.shim_dir().join(if cfg!(target_os = "macos") { "equin Foreign.app" } else { "equin-x.desktop" });
        std::fs::create_dir_all(&foreign).unwrap();
        sync(&host, &roots, &origin(), &helper(&exe, "d1"), &[]).unwrap();
        assert!(foreign.exists());
    }

    #[test]
    fn a_name_that_is_not_a_safe_path_segment_falls_back_to_the_id() {
        for bad in ["../../evil", "a/b", "a:b", ".hidden", "", "x\ny", &"n".repeat(65)] {
            assert_eq!(safe_name(&app("mail", bad, "h")), "mail", "{bad:?}");
        }
        assert_eq!(safe_name(&app("mail", "Mail & News", "h")), "Mail & News");
        let (roots, exe) = home();
        sync(&Fake::new(), &roots, &origin(), &helper(&exe, "d1"), &[app("mail", "../../evil", "h")]).unwrap();
        assert_eq!(ids(&roots), vec!["mail"]);
        assert!(!roots.home.join("evil.app").exists());
    }

    #[test]
    fn a_catalog_id_or_base_path_that_is_not_one_is_refused() {
        let (roots, exe) = home();
        let r = sync(&Fake::new(), &roots, &origin(), &helper(&exe, "d1"), &[app("../x", "X", "h")]).unwrap();
        assert!(r.written.is_empty());
        let mut far = app("mail", "Mail", "h");
        far.base_path = "//evil.com/x".into();
        assert!(sync(&Fake::new(), &roots, &origin(), &helper(&exe, "d1"), &[far]).is_err());
    }

    #[test]
    fn pins_once() {
        let (roots, exe) = home();
        let host = Fake::new();
        sync(&host, &roots, &origin(), &helper(&exe, "d1"), &[app("mail", "Mail", "h1")]).unwrap();
        let mail = shim::installed_in(&roots).pop().unwrap();
        assert_eq!(read_apps(&host, &roots).unwrap().pinned, Vec::<String>::new());
        pin(&host, &mail).unwrap();
        assert_eq!(read_apps(&host, &roots).unwrap().pinned, vec!["mail"]);
        let writes = |h: &Fake| h.commands.borrow().iter().filter(|c| c[1] == "write" || c[1] == "set").count();
        let n = writes(&host);
        pin(&host, &mail).unwrap();
        assert_eq!(writes(&host), n, "already pinned: nothing runs");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_bundle_is_cloned_described_iconed_and_signed() {
        let (roots, exe) = home();
        let host = Fake::new();
        sync(&host, &roots, &origin(), &helper(&exe, "d1"), &[app("mail", "Mail", "h1")]).unwrap();
        assert_eq!(host.programs(), vec!["cp", "iconutil", "codesign"]);
        assert_eq!(host.commands.borrow()[0][2], exe.display().to_string());
        assert_eq!(host.fetched.borrow().len(), ICONSET.len());
        let bundle = roots.mac_applications().join("equin Mail.app");
        let plist = plist::Value::from_file(bundle.join("Contents/Info.plist")).unwrap();
        let d = plist.as_dictionary().unwrap();
        let get = |k: &str| d.get(k).and_then(|v| v.as_string()).unwrap().to_string();
        assert_eq!(get("CFBundleIdentifier"), "dev.equin.app.mail");
        assert_eq!(get("CFBundleExecutable"), "equin-desktop");
        assert_eq!(get("EquinNamespace"), "main");
        assert!(d.get("LSUIElement").is_none());
        assert!(d.get("NSAppTransportSecurity").is_some());
        assert!(!PathBuf::from(format!("{}.staging", bundle.display())).exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_failed_step_leaves_no_half_written_bundle() {
        let (roots, exe) = home();
        let mut host = Fake::new();
        host.fail = Some("codesign");
        assert!(sync(&host, &roots, &origin(), &helper(&exe, "d1"), &[app("mail", "Mail", "h1")]).is_err());
        let left: Vec<_> = std::fs::read_dir(roots.mac_applications()).unwrap().collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn dock_plan_appends_a_tile_then_restarts_the_dock() {
        let bundle = Path::new("/Users/u/Applications/equin Mail.app");
        assert_eq!(dock_file_url(bundle), "file:///Users/u/Applications/equin%20Mail.app/");
        let plan = dock_pin_plan("(\n)", bundle);
        assert_eq!(plan.len(), 2);
        assert!(plan[0][5].contains("file:///Users/u/Applications/equin%20Mail.app/"));
        assert_eq!(plan[1], vec!["killall", "Dock"]);
        assert!(dock_pin_plan("\"_CFURLString\" = \"file:///Users/u/Applications/equin%20Mail.app/\";", bundle).is_empty());
    }

    #[test]
    fn gsettings_arrays_round_trip() {
        assert_eq!(parse_strv("@as []").unwrap(), Vec::<String>::new());
        assert_eq!(parse_strv("['a.desktop', 'it\\'s.desktop']").unwrap(), vec!["a.desktop", "it's.desktop"]);
        assert!(parse_strv("nope").is_err());
        let items = vec!["a.desktop".to_string(), "it's.desktop".to_string()];
        assert_eq!(parse_strv(&render_strv(&items)).unwrap(), items);
        let plan = gnome_pin_plan("['a.desktop']", "mail").unwrap();
        assert_eq!(plan[0][4], "['a.desktop', 'equin-mail.desktop']");
        assert!(gnome_pin_plan("['equin-mail.desktop']", "mail").unwrap().is_empty());
    }

    #[test]
    fn the_catalog_parses_the_servers_shape() {
        struct Answers(HashMap<&'static str, &'static str>);
        impl Host for Answers {
            fn run(&self, _: &[String]) -> Result<String, String> {
                unreachable!()
            }
            fn fetch(&self, path: &str) -> Result<Vec<u8>, String> {
                self.0.get(path).map(|b| b.as_bytes().to_vec()).ok_or_else(|| "404".into())
            }
        }
        let host = Answers(HashMap::from([(
            CATALOG_PATH,
            r#"{"apps":[{"id":"mail","name":"Mail","basePath":"/mail","hash":"h","icons":[{"size":512,"path":"/api/apps/mail/icon/512.png"}]}]}"#,
        )]));
        let apps = fetch_catalog(&host).unwrap();
        assert_eq!(apps[0].base_path, "/mail");
        assert_eq!(apps[0].icon_path(512).unwrap(), "/api/apps/mail/icon/512.png");
    }
}
