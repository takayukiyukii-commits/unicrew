//! UNICREW が `codex` に実際に渡す引数を、そのまま1行1個で標準出力に出す。
//!
//! # なぜ要るか
//!
//! Codex 経路は「引数を1つ間違えると CLI が exit code 2 で即死し、UI からは
//! 『応答が来ない』としか見えない」場所で、実際に2回それが起きている:
//!
//! 1. `-C` を `codex exec resume` に渡していた → 議論モードの2ラリー目から応答が消えた
//! 2. `--ask-for-approval` / `--sandbox` を渡していた
//!    → Plan モードが新規・再開の両方で起動即死（2026-09-01 発見）
//!
//! どちらも「その組み合わせを一度も動かしていない」ことが原因。
//! 手で書き写した引数を試しても意味がないので、
//! **本番と同じ関数**（`providers::codex::build_codex_args`）の出力を取り出す。
//!
//! # 使い方
//!
//! ```text
//! cargo run --example print_codex_args -- <plan|accept> [--resume <sid>] [--cd <dir>] [--image <path>]...
//! ```
//!
//! scripts/verify_codex_route.py が自動でやる。

use unicrew_lib::providers::codex::build_codex_args;
use unicrew_lib::providers::types::PermissionMode;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: print_codex_args <plan|accept> [--resume <sid>] [--cd <dir>] [--image <path>]...");
        std::process::exit(2);
    }

    let mode = match args[0].as_str() {
        "plan" => PermissionMode::Plan,
        _ => PermissionMode::AcceptEdits,
    };

    let mut resume: Option<String> = None;
    let mut cd: Option<String> = None;
    let mut model = String::new();
    let mut images: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--resume" => {
                resume = args.get(i + 1).cloned();
                i += 2;
            }
            "--cd" => {
                cd = args.get(i + 1).cloned();
                i += 2;
            }
            "--model" => {
                model = args.get(i + 1).cloned().unwrap_or_default();
                i += 2;
            }
            "--image" => {
                if let Some(p) = args.get(i + 1) {
                    images.push(p.clone());
                }
                i += 2;
            }
            _ => i += 1,
        }
    }

    for a in build_codex_args(resume.as_deref(), mode, &model, cd.as_deref(), &images) {
        println!("{}", a);
    }
}
