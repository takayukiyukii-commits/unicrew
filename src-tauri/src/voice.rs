//! 音声入力（2026-10-07 追加）。
//!
//! Windows 標準の「音声入力」（Win+H）を呼び出す。カーソルのある入力欄
//! （チャットの入力欄・ターミナル）に、話した言葉がそのまま文字で入る。
//! - API キー不要・追加料金なし・日本語対応（Windows の機能を使うだけ）
//! - 以前の作り（OpenAI の書き起こし）はキーが要るため v0.2.47 で外されていた
//!
//! 🚨 呼ぶ前に、画面側で入力欄にフォーカスを当てておくこと（Win+H はフォーカスの
//!    ある場所に入力する）。

#[cfg(target_os = "windows")]
mod win {
    #[link(name = "user32")]
    extern "system" {
        fn keybd_event(b_vk: u8, b_scan: u8, dw_flags: u32, dw_extra_info: usize);
    }
    const VK_LWIN: u8 = 0x5B;
    const VK_H: u8 = 0x48;
    const KEYEVENTF_KEYUP: u32 = 0x0002;

    pub fn press_win_h() {
        // SAFETY: user32 の keybd_event は引数だけで完結し、ポインタを受け取らない
        unsafe {
            keybd_event(VK_LWIN, 0, 0, 0);
            keybd_event(VK_H, 0, 0, 0);
            keybd_event(VK_H, 0, KEYEVENTF_KEYUP, 0);
            keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, 0);
        }
    }
}

/// 音声入力を始める。対応していない OS では案内文をエラーで返す（画面に出す）。
#[tauri::command]
pub async fn start_voice_typing(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // 🚨 Win+H は「いちばん前にある窓」に入力する。UNICREW が前に無いと、
        //    話した言葉が別のアプリに入ってしまう。押す前に必ずこの窓を前に出す
        let _ = window.unminimize();
        let _ = window.set_focus();
        // 画面側でフォーカスを当てた直後に呼ばれるので、少しだけ待ってから押す
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        if !window.is_focused().unwrap_or(false) {
            return Err("UNICREW の窓を前に出せなかったため、音声入力を始めませんでした（別のアプリに文字が入るのを防ぐため）。もう一度押してください。".into());
        }
        win::press_win_h();
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &window;
        Err("macOS では fn キーを2回押すと音声入力が始まります（システム設定 → キーボード → 音声入力 を ON）。".into())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = &window;
        Err("この OS では音声入力ボタンに対応していません。".into())
    }
}
