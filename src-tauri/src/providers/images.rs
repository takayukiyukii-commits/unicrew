//! 添付画像を「本物の画像」として CLI に渡すための共通処理。
//!
//! # なぜ必要か
//!
//! UNICREW は長らく、添付画像を **パスの文字列** としてしか AI に渡していなかった。
//! 本文に「添付画像（名前）: C:\...\avatars\xxx.png」と書き、
//! 「Read ツールで開いて画像として確認してください」と日本語でお願いするだけだった。
//!
//! ところが CLI の作業ディレクトリはユーザーが選んだワークスペースで、
//! 画像はその外（AppData）にある。Claude Code はワークスペース外の読み取りに
//! 許可を要求するので、実測では次で必ず止まっていた（2026-09-01 再現）:
//!
//! ```text
//! Claude requested permissions to read from D:\...\screenshot.png,
//! but you haven't granted it yet.
//! → 「画像を読み取る権限が許可されなかったため、内容を確認できませんでした」
//! ```
//!
//! 画面にはサムネイルが出ているので、ユーザーは AI にも見えていると信じてしまう。
//! ユーザー側からは切り分けようのない不具合だった。
//!
//! # 直し方
//!
//! claude CLI は `--input-format stream-json` の user メッセージで
//! **content 配列 + image ブロック（base64）** を受け取れる。実測で確認済み
//! （画像のピクセルにしか無い単語を読ませて正答させた・2026-09-01）。
//! ファイルを読ませる必要がそもそも無くなるので、許可の問題ごと消える。
//!
//! # 安全側の作り
//!
//! インライン化できない添付は **黙って諦めて従来動作に戻す**（本文のパス行は
//! 残っているので、AI は今までどおり自力で開こうとする）。つまりこの処理が
//! 失敗しても、v0.3.6 より悪くはならない。

use serde::{Deserialize, Serialize};

/// 1枚あたりの上限（生バイト）。
/// Anthropic の画像ブロックは base64 で約5MBが上限。base64 は 4/3 に膨らむので
/// 生 3.5MB ≒ base64 4.67MB。安全側に倒してここで切る。
pub const MAX_IMAGE_BYTES: u64 = 3_500_000;

/// 1メッセージあたりの枚数上限。貼りすぎで1リクエストが破裂するのを防ぐ。
pub const MAX_IMAGES_PER_MESSAGE: usize = 8;

/// 1メッセージあたりの合計上限（生バイト）。
pub const MAX_TOTAL_IMAGE_BYTES: u64 = 12_000_000;

/// フロントから受け取る添付画像1件。
///
/// base64 ではなく **パス** を受け取る。IPC に数MBの文字列を流さずに済むうえ、
/// 画像は必ず `save_avatar_image` / `save_avatar_bytes` が AppData に置いた
/// ものなので、Rust 側から読めることが保証されている。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InputImage {
    pub path: String,
    /// 画面側が持っている MIME。拡張子から判定できなかったときだけ使う。
    #[serde(default)]
    pub mime: Option<String>,
}

/// 拡張子 → Anthropic の image ブロックが受け付ける media_type。
///
/// 🚨 SVG は対象外。API が受け付けないので、ここで弾いて従来動作
///    （本文のパスを AI 自身に開かせる）に落とす。
pub fn media_type_from_ext(path: &str) -> Option<&'static str> {
    let ext = path
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// 画面側が持っている MIME 文字列 → media_type。拡張子が無いとき用の保険。
pub fn media_type_from_mime(mime: &str) -> Option<&'static str> {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        _ => None,
    }
}

/// この添付をインライン化してよいか決める。拡張子が最優先。
pub fn resolve_media_type(img: &InputImage) -> Option<&'static str> {
    media_type_from_ext(&img.path)
        .or_else(|| img.mime.as_deref().and_then(media_type_from_mime))
}

/// インライン化の結果。
#[derive(Debug, Default)]
pub struct EncodedImages {
    /// Anthropic messages 形式の image ブロック。
    pub blocks: Vec<serde_json::Value>,
    /// インライン化できずに見送った件数（本文のパス行で従来どおり処理される）。
    pub skipped: usize,
}

/// 添付画像を image ブロック列に変換する。
///
/// 変換できないものは黙って `skipped` に数えるだけで、エラーにはしない。
/// **1枚も変換できなくても送信自体は必ず成功させる**（従来動作に戻るだけ）。
pub fn encode_images(images: &[InputImage]) -> EncodedImages {
    use base64::Engine;

    let mut out = EncodedImages::default();
    let mut total: u64 = 0;

    for img in images {
        if out.blocks.len() >= MAX_IMAGES_PER_MESSAGE {
            out.skipped += 1;
            continue;
        }
        let media_type = match resolve_media_type(img) {
            Some(m) => m,
            None => {
                out.skipped += 1;
                continue;
            }
        };
        let meta = match std::fs::metadata(&img.path) {
            Ok(m) => m,
            Err(_) => {
                out.skipped += 1;
                continue;
            }
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_IMAGE_BYTES {
            out.skipped += 1;
            continue;
        }
        if total + meta.len() > MAX_TOTAL_IMAGE_BYTES {
            out.skipped += 1;
            continue;
        }
        let bytes = match std::fs::read(&img.path) {
            Ok(b) => b,
            Err(_) => {
                out.skipped += 1;
                continue;
            }
        };
        total += bytes.len() as u64;
        out.blocks.push(serde_json::json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": base64::engine::general_purpose::STANDARD.encode(&bytes),
            }
        }));
    }
    out
}

/// インライン化に成功したときだけ本文の末尾に足す一文。
///
/// これが無いと、AI は本文に残っているパス行を見て律儀にファイルを開きに行き、
/// 許可で弾かれて「読めませんでした」と答えてしまう（画像は手元にあるのに）。
pub fn inline_notice(count: usize) -> String {
    format!(
        "\n\n（添付画像{}枚はこのメッセージに画像として添付済みです。上記のパスをファイルとして開く必要はありません）",
        count
    )
}

/// 添付画像のうち「CLI にファイルとして渡せるもの」のパスだけを返す。
///
/// codex CLI は base64 ではなく **ファイルパス** を受け取る（`codex exec --image=<FILE>`）。
/// claude 経路の base64 とは渡し方が違うだけで、選別の基準は同じにしておく。
///
/// 🚨 `--image` は可変長引数（`<FILE>...`）なので、呼び出し側は必ず
///    `--image=<path>` と **1引数に = 連結** して渡すこと。`--image <path>` と
///    分けると、後ろに置いた `-`（stdin からプロンプトを読む指定）まで
///    画像ファイルとして飲み込まれる。claude の `--allowedTools` で踏んだのと同じ罠。
pub fn usable_image_paths(images: &[InputImage]) -> (Vec<String>, usize) {
    let mut paths = Vec::new();
    let mut skipped = 0usize;
    let mut total: u64 = 0;

    for img in images {
        if paths.len() >= MAX_IMAGES_PER_MESSAGE {
            skipped += 1;
            continue;
        }
        if resolve_media_type(img).is_none() {
            skipped += 1;
            continue;
        }
        let meta = match std::fs::metadata(&img.path) {
            Ok(m) => m,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_IMAGE_BYTES {
            skipped += 1;
            continue;
        }
        if total + meta.len() > MAX_TOTAL_IMAGE_BYTES {
            skipped += 1;
            continue;
        }
        total += meta.len();
        paths.push(img.path.clone());
    }
    (paths, skipped)
}

/// claude CLI の stream-json 入力に流す user メッセージ1件を組み立てる。
///
/// 画像が1枚も無いときは従来どおり `content` を **文字列** のまま返す
/// （形を変えないほうが安全。既存の全経路がこの形で通っている）。
/// 画像があるときだけ content 配列にして image ブロックを先に並べる。
///
/// claude.rs はこの関数の返り値をそのまま1行 JSON にして書き込む。
/// テストと実機検証（examples/print_user_payload.rs）が
/// **本番と同じ関数**を通るようにするため、ここに置いてある。
pub fn build_user_payload(text: &str, images: &[InputImage]) -> (serde_json::Value, usize) {
    let encoded = encode_images(images);
    if encoded.blocks.is_empty() {
        return (
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": text },
            }),
            encoded.skipped,
        );
    }
    let mut content = encoded.blocks;
    let body = format!("{}{}", text, inline_notice(content.len()));
    content.push(serde_json::json!({ "type": "text", "text": body }));
    (
        serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": content },
        }),
        encoded.skipped,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmpdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "unicrew-images-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_file(dir: &std::path::Path, name: &str, len: usize) -> String {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(&vec![7u8; len]).unwrap();
        p.to_string_lossy().to_string()
    }

    fn img(path: &str) -> InputImage {
        InputImage {
            path: path.to_string(),
            mime: None,
        }
    }

    #[test]
    fn media_type_is_taken_from_extension_case_insensitively() {
        assert_eq!(media_type_from_ext("a/b/c.PNG"), Some("image/png"));
        assert_eq!(media_type_from_ext("x.jpg"), Some("image/jpeg"));
        assert_eq!(media_type_from_ext("x.jpeg"), Some("image/jpeg"));
        assert_eq!(media_type_from_ext("x.gif"), Some("image/gif"));
        assert_eq!(media_type_from_ext("x.webp"), Some("image/webp"));
    }

    #[test]
    fn svg_is_never_inlined() {
        // Anthropic の image ブロックは SVG を受け付けない。
        // 弾いて従来動作（AI 自身にファイルを開かせる）へ落とす。
        assert_eq!(media_type_from_ext("logo.svg"), None);
        assert_eq!(media_type_from_mime("image/svg+xml"), None);
    }

    #[test]
    fn mime_is_used_only_when_extension_is_unknown() {
        let a = InputImage {
            path: "no-ext-file".into(),
            mime: Some("image/png".into()),
        };
        assert_eq!(resolve_media_type(&a), Some("image/png"));
        // 拡張子が分かるときは拡張子が勝つ
        let b = InputImage {
            path: "x.gif".into(),
            mime: Some("image/png".into()),
        };
        assert_eq!(resolve_media_type(&b), Some("image/gif"));
    }

    #[test]
    fn encodes_a_real_file_into_a_base64_block() {
        let d = tmpdir();
        let p = write_file(&d, "shot.png", 32);
        let r = encode_images(&[img(&p)]);
        assert_eq!(r.skipped, 0);
        assert_eq!(r.blocks.len(), 1);
        assert_eq!(r.blocks[0]["type"], "image");
        assert_eq!(r.blocks[0]["source"]["type"], "base64");
        assert_eq!(r.blocks[0]["source"]["media_type"], "image/png");
        assert!(!r.blocks[0]["source"]["data"]
            .as_str()
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn missing_empty_and_oversized_files_are_skipped_not_errors() {
        let d = tmpdir();
        let missing = d.join("nope.png").to_string_lossy().to_string();
        let empty = write_file(&d, "empty.png", 0);
        let big = write_file(&d, "big.png", (MAX_IMAGE_BYTES + 1) as usize);
        let r = encode_images(&[img(&missing), img(&empty), img(&big)]);
        assert_eq!(r.blocks.len(), 0);
        assert_eq!(r.skipped, 3);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn per_message_count_is_capped() {
        let d = tmpdir();
        let mut v = Vec::new();
        for i in 0..(MAX_IMAGES_PER_MESSAGE + 3) {
            v.push(img(&write_file(&d, &format!("s{}.png", i), 16)));
        }
        let r = encode_images(&v);
        assert_eq!(r.blocks.len(), MAX_IMAGES_PER_MESSAGE);
        assert_eq!(r.skipped, 3);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn empty_input_produces_no_blocks_and_no_skips() {
        let r = encode_images(&[]);
        assert!(r.blocks.is_empty());
        assert_eq!(r.skipped, 0);
    }

    #[test]
    fn usable_paths_applies_the_same_rules_as_base64_encoding() {
        let d = tmpdir();
        let ok = write_file(&d, "shot.png", 40);
        let empty = write_file(&d, "empty.png", 0);
        let big = write_file(&d, "big.png", (MAX_IMAGE_BYTES + 1) as usize);
        let missing = d.join("nope.png").to_string_lossy().to_string();
        let (paths, skipped) = usable_image_paths(&[
            img(&ok),
            img(&empty),
            img(&big),
            img(&missing),
            img("logo.svg"),
        ]);
        assert_eq!(paths, vec![ok]);
        assert_eq!(skipped, 4);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn usable_paths_is_capped_like_the_base64_path() {
        let d = tmpdir();
        let mut v = Vec::new();
        for i in 0..(MAX_IMAGES_PER_MESSAGE + 2) {
            v.push(img(&write_file(&d, &format!("s{}.png", i), 16)));
        }
        let (paths, skipped) = usable_image_paths(&v);
        assert_eq!(paths.len(), MAX_IMAGES_PER_MESSAGE);
        assert_eq!(skipped, 2);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn payload_without_images_keeps_the_legacy_string_shape() {
        // 画像が無いときに形を変えると、既存の全会話が道連れになる。
        let (v, skipped) = build_user_payload("こんにちは", &[]);
        assert_eq!(skipped, 0);
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "こんにちは");
        assert!(v["message"]["content"].is_string());
    }

    #[test]
    fn payload_with_images_puts_images_first_then_text() {
        let d = tmpdir();
        let p = write_file(&d, "shot.png", 24);
        let (v, skipped) = build_user_payload("これ何？", &[img(&p)]);
        assert_eq!(skipped, 0);
        let c = v["message"]["content"].as_array().unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0]["type"], "image");
        assert_eq!(c[1]["type"], "text");
        let t = c[1]["text"].as_str().unwrap();
        assert!(t.starts_with("これ何？"));
        // 画像を添えたのにファイルを開きに行かせないための一文
        assert!(t.contains("開く必要はありません"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn payload_falls_back_to_legacy_shape_when_every_image_is_unusable() {
        // SVG しか無い等。壊すくらいなら従来動作に戻す。
        let (v, skipped) = build_user_payload("見て", &[img("C:/a/logo.svg")]);
        assert_eq!(skipped, 1);
        assert!(v["message"]["content"].is_string());
        assert_eq!(v["message"]["content"], "見て");
    }

    #[test]
    fn notice_tells_the_model_not_to_open_the_path() {
        let s = inline_notice(2);
        assert!(s.contains("2枚"));
        assert!(s.contains("開く必要はありません"));
    }
}
