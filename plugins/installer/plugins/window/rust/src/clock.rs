//! The current instant as the protocol's `t` (ISO-8601 UTC, seconds), for the
//! log events the window writes itself (the script's own stdout / stderr).

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso(secs)
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

fn iso(secs: i64) -> String {
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let s = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        s / 3600,
        (s % 3600) / 60,
        s % 60
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn formats_utc() {
        assert_eq!(super::iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(super::iso(1_794_927_486), "2026-11-17T14:58:06Z");
        assert_eq!(super::iso(951_782_400), "2000-02-29T00:00:00Z");
    }
}
