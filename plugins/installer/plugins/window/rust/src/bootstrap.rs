//! Self-bootstrap: `equin-installer` with no `--script`.
//!
//! The curl install hands the window a script it already downloaded and
//! verified (install.sh's stage 0). Started on its own — the later notarized
//! double-click app, with no shell around it — the binary does stage 0's
//! fetch itself: the release's `release.json`, `SHA256SUMS` and `install.sh`,
//! every file checked against `SHA256SUMS`, then runs that script as usual.
//! A mismatch is fatal; nothing unverified ever runs.
//!
//! The release layout (asset names, `release.json`) is the release workflow's
//! (`.github/workflows/installer-release.yml`, described by
//! `plugins/installer/plugins/release-assets`); stage 0 in install.sh reads
//! the same files the same way.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// Where releases are downloaded from. `EQUIN_RELEASES_URL` points it at a
/// test server (the same override stage 0 honours).
const RELEASES_URL: &str = "https://github.com/equinai/equin/releases";

/// The subset of `release.json` the bootstrap reads.
#[derive(Deserialize)]
struct ReleaseManifest {
    v: u32,
    tag: String,
    /// 1 when the release's install.sh accepts `--release` / `--checkout`
    /// (it can be run as a release's script); null for releases cut before.
    handoff: Option<u32>,
}

pub struct Fetched {
    /// The verified install.sh.
    pub script: String,
    /// What to pass it first: which release it is, what to check out.
    pub handoff_args: Vec<String>,
}

/// Download and verify the release (`release_ref`: a tag; none = the newest).
pub fn fetch(release_ref: Option<&str>) -> Result<Fetched, String> {
    let base = std::env::var("EQUIN_RELEASES_URL").unwrap_or_else(|_| RELEASES_URL.to_string());
    let base = base.trim_end_matches('/');
    let dir = std::env::temp_dir().join(format!("equin-installer-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("equin-installer: cannot create {}: {e}", dir.display()))?;

    let manifest_url = match release_ref {
        Some(tag) => format!("{base}/download/{tag}/release.json"),
        None => format!("{base}/latest/download/release.json"),
    };
    let manifest_path = dir.join("release.json");
    download(&manifest_url, &manifest_path)?;
    let manifest_bytes = read(&manifest_path)?;
    let manifest: ReleaseManifest = serde_json::from_slice(&manifest_bytes).map_err(|e| {
        format!("equin-installer: the release's description could not be read ({e}); from {manifest_url}")
    })?;
    if manifest.v != 1 {
        return Err(format!(
            "This installer is too old for the newest equin release. Download the installer again.\n  details: release.json v{} (this binary reads v1)",
            manifest.v
        ));
    }
    if manifest.handoff != Some(1) {
        return Err(format!(
            "equin {} can't be installed from this installer window. Install it from a terminal instead:\n\n    curl -fsSL https://raw.githubusercontent.com/equinai/equin/main/install.sh | bash\n\n  details: release.json has no handoff (the release predates the installer window)",
            manifest.tag
        ));
    }
    let tag = manifest.tag;

    // Everything else comes from that one tag, so a newer release published
    // meanwhile can never mix with this one.
    let sums_path = dir.join("SHA256SUMS");
    download(&format!("{base}/download/{tag}/SHA256SUMS"), &sums_path)?;
    let sums = String::from_utf8(read(&sums_path)?)
        .map_err(|_| "equin-installer: SHA256SUMS is not text".to_string())?;
    let script_path = dir.join("install.sh");
    download(&format!("{base}/download/{tag}/install.sh"), &script_path)?;
    verify(&sums, "release.json", &manifest_bytes)?;
    verify(&sums, "install.sh", &read(&script_path)?)?;

    Ok(Fetched {
        script: script_path.to_string_lossy().into_owned(),
        handoff_args: vec!["--release".into(), tag.clone(), "--checkout".into(), tag],
    })
}

fn download(url: &str, to: &Path) -> Result<(), String> {
    let status = Command::new("curl")
        .args(["-fsSL", "--retry", "2", "-o"])
        .arg(to)
        .arg(url)
        .status()
        .map_err(|e| format!("equin-installer: could not run curl to download {url}: {e}"))?;
    if !status.success() {
        return Err(format!(
            "equin's installer could not download the release. Check your internet connection, then try again.\n  details: curl {url} exited {status}"
        ));
    }
    Ok(())
}

fn read(path: &PathBuf) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("equin-installer: cannot read {}: {e}", path.display()))
}

/// The file's sha256 must be the one SHA256SUMS lists for its name.
fn verify(sums: &str, name: &str, bytes: &[u8]) -> Result<(), String> {
    let expected = sums.lines().find_map(|line| {
        let (hash, file) = line.split_once("  ")?;
        (file.trim_start_matches('*') == name).then(|| hash.trim().to_ascii_lowercase())
    });
    let actual = format!("{:x}", Sha256::digest(bytes));
    match expected {
        Some(hash) if hash == actual => Ok(()),
        Some(hash) => Err(damaged(&format!("{name}: sha256 {actual}, SHA256SUMS lists {hash}"))),
        None => Err(damaged(&format!("SHA256SUMS lists no {name}"))),
    }
}

fn damaged(details: &str) -> String {
    format!("The download was damaged or changed, so equin's installer stopped. Nothing was installed.\n  details: {details}")
}
