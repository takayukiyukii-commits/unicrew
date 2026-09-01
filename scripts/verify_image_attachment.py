#!/usr/bin/env python
"""添付画像が本当に AI に見えているかを、実物の claude CLI で測る。

# なぜこのスクリプトが要るか

「AI が添付画像を見られない」は 2026-05-18 に一度「直した」と報告して出荷し、
それから 106 日間ずっと壊れたままだった。そのときの検証欄はこの1行だけ:

    検証: npx tsc --noEmit クリーン（exit 0）

型が通ることと、AI が画像を見られることには何の関係もない。
だからここでは **本物の claude CLI を起動して、画像のピクセルにしか存在しない
単語を読ませる**。答えられなければ落ちる。

# 何を本物のまま使うか

- 送る JSON     : cargo example `print_user_payload`（本番と同じ build_user_payload）
- 本文          : lib/attachment-prompt.ts と同じ文面
- CLI の引数    : src-tauri/src/providers/claude.rs と同じ並び
- 画像の置き場所: ワークスペースの **外**（実際の AppData と同じ条件）

# 使い方

    python scripts/verify_image_attachment.py            # 修正後の挙動
    python scripts/verify_image_attachment.py --legacy   # 修正前の挙動（落ちるのが正しい）

claude CLI にログイン済みであることが前提。
"""

from __future__ import annotations

import json
import os
import random
import shutil
import string
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC_TAURI = REPO / "src-tauri"

# claude.rs が組み立てるのと同じ並び（--permission-prompt-tool は対話が要るので外す）
CLI_ARGS = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools=WebSearch,WebFetch",
]


def make_secret_image(path: Path) -> str:
    """ピクセルにしか存在しない単語を焼いた画像を作る。

    この単語はパス名にもファイル名にも本文にも出てこない。
    AI が言い当てられたら、それは画像を本当に見たということ。
    """
    from PIL import Image, ImageDraw, ImageFont

    word = "UNICREW-" + "".join(random.choices(string.ascii_uppercase, k=3)) + \
        "-" + "".join(random.choices(string.digits, k=4))
    im = Image.new("RGB", (760, 220), (255, 255, 255))
    d = ImageDraw.Draw(im)
    font = None
    for candidate in (
        r"C:\Windows\Fonts\arialbd.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if os.path.exists(candidate):
            font = ImageFont.truetype(candidate, 46)
            break
    d.text((30, 80), word, fill=(0, 0, 0), font=font)
    im.save(path)
    return word


def build_payload_via_rust(text: str, image: Path | None) -> str:
    """本番と同じ Rust 関数に JSON を作らせる。手書きの JSON は使わない。"""
    args = ["cargo", "run", "--quiet", "--example", "print_user_payload", "--", text]
    if image is not None:
        args.append(str(image))
    out = subprocess.run(
        args, cwd=SRC_TAURI, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        raise SystemExit(f"example の実行に失敗しました:\n{out.stderr}")
    for line in out.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            return line
    raise SystemExit(f"payload を取り出せませんでした:\n{out.stdout}")


def run_claude(payload_line: str, workspace: Path) -> dict:
    p = subprocess.Popen(
        CLI_ARGS, cwd=str(workspace),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    p.stdin.write(payload_line + "\n")
    p.stdin.flush()

    seen = {"text": "", "tools": [], "denials": [], "error": None}
    start = time.time()
    try:
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                v = json.loads(line)
            except Exception:
                continue
            t = v.get("type")
            if t == "assistant":
                for b in v["message"]["content"]:
                    if b.get("type") == "text":
                        seen["text"] += b["text"]
                    elif b.get("type") == "tool_use":
                        seen["tools"].append(b["name"])
            elif t == "result":
                seen["denials"] = v.get("permission_denials") or []
                seen["error"] = v.get("is_error")
                break
            if time.time() - start > 180:
                break
    finally:
        try:
            p.stdin.close()
        except Exception:
            pass
        p.terminate()
    return seen


def main() -> int:
    legacy = "--legacy" in sys.argv
    tmp = Path(tempfile.mkdtemp(prefix="unicrew-imgverify-"))
    workspace = tmp / "workspace"
    outside = tmp / "appdata" / "avatars"   # 実際の添付置き場と同じ「ワークスペース外」
    workspace.mkdir(parents=True)
    outside.mkdir(parents=True)

    image = outside / "screenshot-verify.png"
    word = make_secret_image(image)

    # lib/attachment-prompt.ts が作るのと同じ本文。
    # 🚨 実装とここがズレたら「別の文面を検証している」ことになるので、機械で照合する。
    note = (
        "上記の画像は、テキストとしてではなく画像として内容を確認したうえで"
        "回答してください。画像が直接見えていない場合のみ、上記のパスの"
        "ファイルを開いてください。"
    )
    ts = (REPO / "lib" / "attachment-prompt.ts").read_text(encoding="utf-8")
    # 空白・改行・文字列の連結記号を落として比べる（体裁の違いは無視、文言の違いだけ見る）
    def flatten(x: str) -> str:
        out = ''.join(x.split())
        for ch in ('"', '+', chr(39)):
            out = out.replace(ch, '')
        return out

    if flatten(note) not in flatten(ts):
        raise SystemExit(
            '実装（lib/attachment-prompt.ts の IMAGE_NOTE）と、この検証スクリプトの'
            '文面がズレています。どちらかを直してください。'
        )

    text = (
        "この画像に書いてある単語をそのまま1つだけ答えて。説明は不要。\n\n"
        f"添付画像（{image.name}）: {image}\n\n"
        "上記の画像は、テキストとしてではなく画像として内容を確認したうえで"
        "回答してください。画像が直接見えていない場合のみ、上記のパスの"
        "ファイルを開いてください。"
    )

    print(f"作業場       : {tmp}")
    print(f"ワークスペース: {workspace}")
    print(f"画像         : {image}（ワークスペースの外）")
    print(f"合言葉       : {word}（画像のピクセルにしか無い）")
    print(f"モード       : {'修正前（画像を渡さない）' if legacy else '修正後（画像を渡す）'}")
    print("-" * 70)

    payload = build_payload_via_rust(text, None if legacy else image)
    shape = json.loads(payload)["message"]["content"]
    print(f"送る content : {'文字列（従来の形）' if isinstance(shape, str) else f'配列 {len(shape)} ブロック'}")
    print(f"payload 長   : {len(payload):,} バイト")
    print("-" * 70)

    seen = run_claude(payload, workspace)
    print(f"使った道具   : {seen['tools'] or 'なし'}")
    print(f"許可の却下   : {[d.get('tool_name') for d in seen['denials']] or 'なし'}")
    print(f"AI の答え    : {seen['text'].strip()[:200]}")
    print("-" * 70)

    found = word in seen["text"]
    shutil.rmtree(tmp, ignore_errors=True)

    if legacy:
        if found:
            print("想定外: 修正前の形でも読めてしまった。前提が変わっている可能性がある")
            return 1
        print("PASS（修正前は読めない、を再現）: 画像が見えていないことを確認した")
        return 0

    if not found:
        print("FAIL: AI が画像の中の単語を答えられなかった＝画像が届いていない")
        return 1
    if seen["denials"]:
        print("FAIL: 許可の却下が発生した＝ファイルを開きに行ってしまっている")
        return 1
    print("PASS: 画像のピクセルにしか無い単語を答えた＝画像が本当に届いている")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
