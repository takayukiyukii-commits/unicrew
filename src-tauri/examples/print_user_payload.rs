//! UNICREW が claude CLI の stdin に実際に書き込む1行を、そのまま標準出力に出す。
//!
//! # なぜ要るか
//!
//! 添付画像が AI に見えない不具合は、2026-05-18 に一度「直した」と報告して
//! 出荷したのに、106日間ずっと壊れたままだった。そのときの検証欄は
//! `npx tsc --noEmit クリーン` の1行だけ。型が通ることと、AI が画像を
//! 見られることには何の関係もなかった。
//!
//! 同じ失敗を繰り返さないために、**本番とまったく同じ関数**
//! （`providers::images::build_user_payload`）が作った1行を取り出して、
//! 本物の claude CLI に食わせられるようにしてある。
//! 手で書き写した「それっぽいJSON」を試しても意味がないので、必ずここを通す。
//!
//! # 使い方
//!
//! ```text
//! cargo run --example print_user_payload -- "この画像の単語は？" C:\path\to\shot.png
//! ```
//!
//! 出てきた1行をそのまま claude の stdin に流すと、実機の挙動が測れる。
//! （scripts/verify_image_attachment.py が自動でやる）

fn main() {
    let mut args = std::env::args().skip(1);
    let text = args.next().unwrap_or_else(|| {
        eprintln!("usage: print_user_payload <text> [image_path ...]");
        std::process::exit(2);
    });
    let images: Vec<unicrew_lib::providers::images::InputImage> = args
        .map(|p| unicrew_lib::providers::images::InputImage {
            path: p,
            mime: None,
        })
        .collect();

    let (payload, skipped) =
        unicrew_lib::providers::images::build_user_payload(&text, &images);
    if skipped > 0 {
        eprintln!("skipped={}", skipped);
    }
    println!("{}", serde_json::to_string(&payload).unwrap());
}
