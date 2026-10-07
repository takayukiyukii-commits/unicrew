//! 作業が終わったことを知らせる仕組み（2026-10-07 追加）。
//!
//! - タスクトレイ（通知領域）にアイコンを常駐させる。左クリックで UNICREW を前に出す。
//!   右クリックのメニューに「開く」「終了」
//! - 未確認の完了があると、トレイのアイコンとタスクバーのボタンに赤い印を付ける
//!   （Windows はタスクバーの数字バッジが無いので overlay icon。macOS は Dock の数字）
//! - 作業完了を OS の通知で出す
//! - 「×で閉じても常駐」が ON なら、メイン窓の × は終了ではなく隠すだけにする
//!
//! 🚨 常駐の既定は Rust 側では OFF。画面側が設定を読んで `set_tray_resident(true)` を
//!    送ってきてから ON になる。画面が壊れて起動しなかったときに「× で終われない」を作らない。
//! 🚨 印の画像はファイルを足さず、アプリのアイコンから実行時に作る（版を上げても絵がずれない）。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

const TRAY_ID: &str = "unicrew-main";
const MAIN_WINDOW: &str = "main";

static TRAY_RESIDENT: AtomicBool = AtomicBool::new(false);
static TOLD_RESIDENT: AtomicBool = AtomicBool::new(false);
static UNREAD: AtomicU32 = AtomicU32::new(0);

/// 赤い印の色（RGBA）。
const DOT: [u8; 4] = [0xF0, 0x3E, 0x3E, 0xFF];
const RIM: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFF];

/// タスクバーに重ねる印の一辺（px）。16px だと高 DPI で拡大されて粗く見えるので 32px で作る。
pub const DOT_ICON_SIZE: u32 = 32;

/// 1 画素のうち円（半径 r）に入る割合（4x4 の点で数える＝縁をなめらかにする）。
fn coverage(px: u32, py: u32, cx: f32, cy: f32, r: f32) -> f32 {
    let mut hit = 0u32;
    for sy in 0..4 {
        for sx in 0..4 {
            let dx = px as f32 + (sx as f32 + 0.5) / 4.0 - cx;
            let dy = py as f32 + (sy as f32 + 0.5) / 4.0 - cy;
            if dx * dx + dy * dy <= r * r {
                hit += 1;
            }
        }
    }
    hit as f32 / 16.0
}

/// `color` を割合 `a` で重ねる（下の画素の透明度も保つ）。
fn blend(dst: &mut [u8], color: [u8; 4], a: f32) {
    if a <= 0.0 {
        return;
    }
    let da = dst[3] as f32 / 255.0;
    let oa = a + da * (1.0 - a);
    for k in 0..3 {
        let c = (color[k] as f32 * a + dst[k] as f32 * da * (1.0 - a)) / oa;
        dst[k] = c.round().clamp(0.0, 255.0) as u8;
    }
    dst[3] = (oa * 255.0).round().clamp(0.0, 255.0) as u8;
}

/// 白い細い縁つきの赤い丸を、中心 (cx, cy)・半径 r で描く。
fn paint_dot(out: &mut [u8], w: u32, h: u32, cx: f32, cy: f32, r: f32, rim: f32) {
    for y in 0..h {
        for x in 0..w {
            let outer = coverage(x, y, cx, cy, r + rim);
            if outer <= 0.0 {
                continue;
            }
            let inner = coverage(x, y, cx, cy, r);
            let i = ((y * w + x) * 4) as usize;
            blend(&mut out[i..i + 4], RIM, outer);
            blend(&mut out[i..i + 4], DOT, inner);
        }
    }
}

/// アイコンの右上に小さな赤い丸を重ねた RGBA を返す（元の画像は変えない）。
pub fn with_badge(rgba: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = rgba.to_vec();
    let size = w.min(h) as f32;
    let r = size * 0.17;
    let rim = size * 0.035;
    let cx = w as f32 - r - rim - size * 0.03;
    let cy = r + rim + size * 0.03;
    paint_dot(&mut out, w, h, cx, cy, r, rim);
    out
}

/// タスクバーのボタンに重ねる小さな赤丸（Windows の overlay icon 用）。
/// Windows は印をボタンの右下に置くので、丸も画像の右下寄りに描いてアイコンの角に添わせる。
pub fn dot_icon() -> Vec<u8> {
    let n = DOT_ICON_SIZE;
    let mut out = vec![0u8; (n * n * 4) as usize];
    let s = n as f32;
    let r = s * 0.21;
    let rim = s * 0.055;
    let c = s - r - rim - s * 0.04;
    paint_dot(&mut out, n, n, c, c, r, rim);
    out
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 起動時に1回呼ぶ。トレイのアイコンを作る。
pub fn setup_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "unicrew-open", "UNICREW を開く", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "unicrew-quit", "UNICREW を終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut b = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("UNICREW")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "unicrew-open" => show_main(app),
            // 常駐中でも確実に終われる道。exit は CloseRequested を通らない
            "unicrew-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        b = b.icon(icon.clone());
    }
    b.build(app)?;
    Ok(())
}

/// 未確認の件数を反映する（0 で印を消す）。
pub fn apply_unread<R: Runtime>(app: &AppHandle<R>, count: u32) {
    UNREAD.store(count, Ordering::Relaxed);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Some(base) = app.default_window_icon() {
            let img = if count > 0 {
                Image::new_owned(
                    with_badge(base.rgba(), base.width(), base.height()),
                    base.width(),
                    base.height(),
                )
            } else {
                base.clone().to_owned()
            };
            let _ = tray.set_icon(Some(img));
        }
        let tip = if count > 0 {
            format!("UNICREW — 終わった作業が {} 件あります", count)
        } else {
            "UNICREW".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        #[cfg(target_os = "windows")]
        {
            let icon = if count > 0 {
                Some(Image::new_owned(dot_icon(), DOT_ICON_SIZE, DOT_ICON_SIZE))
            } else {
                None
            };
            let _ = w.set_overlay_icon(icon);
        }
        #[cfg(target_os = "macos")]
        {
            let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let _ = &w;
        }
    }
}

pub fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// メイン窓の × が押されたとき。常駐が ON なら隠して true を返す（呼び出し側が閉じるのを止める）。
pub fn hide_instead_of_close<R: Runtime>(window: &tauri::Window<R>) -> bool {
    if window.label() != MAIN_WINDOW || !TRAY_RESIDENT.load(Ordering::Relaxed) {
        return false;
    }
    let _ = window.hide();
    // 1回目だけ「終わったのではなく常駐している」と知らせる（消えたと思われないように）
    if !TOLD_RESIDENT.swap(true, Ordering::Relaxed) {
        let _ = notify(
            window.app_handle(),
            "UNICREW は通知領域で動いています",
            "作業が終わったらお知らせします。終了するときは通知領域のアイコンを右クリック →「UNICREW を終了」",
        );
    }
    true
}

#[tauri::command]
pub fn set_tray_resident(enabled: bool) {
    TRAY_RESIDENT.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_unread_badge(app: AppHandle, count: u32) {
    apply_unread(&app, count);
}

#[tauri::command]
pub fn notify_work_done(app: AppHandle, title: String, body: String) -> Result<(), String> {
    notify(&app, &title, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_paints_top_right_and_keeps_the_rest() {
        let w = 32;
        let h = 32;
        let src = vec![10u8; (w * h * 4) as usize];
        let out = with_badge(&src, w, h);
        assert_eq!(out.len(), src.len());
        // 右上の丸の中心は赤
        let r = 32.0 * 0.17;
        let cx = (32.0 - r - 32.0 * 0.035 - 32.0 * 0.03) as u32;
        let cy = (r + 32.0 * 0.035 + 32.0 * 0.03) as u32;
        let i = ((cy * w + cx) * 4) as usize;
        assert_eq!(&out[i..i + 4], &DOT);
        // 左下は元のまま
        let j = (((h - 1) * w) * 4) as usize;
        assert_eq!(&out[j..j + 4], &[10, 10, 10, 10]);
    }

    #[test]
    fn dot_icon_is_small_round_and_smooth() {
        let n = DOT_ICON_SIZE;
        let d = dot_icon();
        assert_eq!(d.len(), (n * n * 4) as usize);
        // 左上の角は透明（丸が小さい）
        assert_eq!(&d[0..4], &[0, 0, 0, 0]);
        // 丸の中心は赤
        let s = n as f32;
        let c = (s - s * 0.21 - s * 0.055 - s * 0.04) as u32;
        let center = ((c * n + c) * 4) as usize;
        assert_eq!(&d[center..center + 4], &DOT);
        // 縁は中間の透明度を持つ画素がある（ギザギザでない）
        let partial = d.chunks(4).filter(|p| p[3] > 0 && p[3] < 255).count();
        assert!(partial >= 8, "なめらかな縁の画素が少ない: {partial}");
    }

    /// 目視確認用に PNG の元データを書き出す（通常のテストでは走らない）。
    #[test]
    #[ignore]
    fn dump_preview() {
        let dir = std::env::var("UNICREW_BADGE_DUMP").expect("UNICREW_BADGE_DUMP");
        std::fs::write(format!("{dir}/dot.rgba"), dot_icon()).unwrap();
        let src = vec![0x40u8; 64 * 64 * 4];
        std::fs::write(format!("{dir}/badge64.rgba"), with_badge(&src, 64, 64)).unwrap();
    }

    #[test]
    fn resident_is_off_until_the_screen_turns_it_on() {
        // 画面が設定を送る前に × を押されたら、従来どおり終了させる
        assert!(!TRAY_RESIDENT.load(Ordering::Relaxed));
    }
}
