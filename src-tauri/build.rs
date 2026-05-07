// Bump this string to force a full rebuild when only icon files change
// (cargo doesn't fingerprint icon assets via tauri-build by default).
// Last bumped: 2026-05-08 — Pattern B brand icons adopted.
const _ICON_REBUILD_FINGERPRINT: &str = "2026-05-08-b-transparent";

fn main() {
    tauri_build::build()
}
