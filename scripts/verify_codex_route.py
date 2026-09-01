#!/usr/bin/env python
"""Codex 経路が本当に動くかを、実物の codex CLI で測る。

# なぜこのスクリプトが要るか

Codex 経路は「引数を1つ間違えると CLI が exit code 2 で即死し、UI からは
『応答が来ない』としか見えない」場所で、実際に2回それが起きている:

 1. `-C` を `codex exec resume` に渡していた → 議論モードの2ラリー目から応答が消えた
 2. `--ask-for-approval` / `--sandbox` を渡していた
    → **Plan モードが新規・再開の両方で起動即死**（2026-09-01 発見）

どちらも「その組み合わせを一度も動かしていない」ことが原因だった。
だからここでは全部の組み合わせを実際に起動する。

# 何を本物のまま使うか

- 引数: cargo example `print_codex_args`（本番と同じ `build_codex_args`）
- 画像: 実ファイル。ピクセルにしか無い単語を読ませて確かめる

# 測ること

| # | 何を | 合格 |
|---|---|---|
| 1 | AcceptEdits の新規セッション | 起動して応答する |
| 2 | Plan の新規セッション | 起動して応答する（旧実装は exit 2 で即死） |
| 3 | Plan で書き込みを頼む | 実際にファイルが作られない |
| 4 | Plan の resume | 起動して応答する（旧実装は exit 2 で即死） |
| 5 | 画像添付 | 画像の中にしか無い単語を答える・ファイルを開かない |

# 使い方

    python scripts/verify_codex_route.py

codex CLI にログイン済みであることが前提。
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
TIMEOUT_SEC = 300


def make_secret_image(path: Path) -> str:
    """ピクセルにしか存在しない単語を焼いた画像を作る。"""
    from PIL import Image, ImageDraw, ImageFont

    word = (
        "UNICREW-"
        + "".join(random.choices(string.ascii_uppercase, k=3))
        + "-"
        + "".join(random.choices(string.digits, k=4))
    )
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


def codex_args(*spec: str) -> list[str]:
    """本番と同じ Rust 関数に引数を作らせる。手書きの引数は使わない。"""
    out = subprocess.run(
        ["cargo", "run", "--quiet", "--example", "print_codex_args", "--", *spec],
        cwd=SRC_TAURI,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if out.returncode != 0:
        raise SystemExit(f"example の実行に失敗しました:\n{out.stderr}")
    return [l for l in out.stdout.splitlines() if l.strip()]


def codex_exe() -> str:
    """Windows の `codex` は .cmd シムなので、実体を解決してから起動する。

    （Rust 側の build_silent_command は shim 解決を内蔵しているが、
    Python の subprocess は解決しないので FileNotFoundError になる）
    """
    for name in ("codex", "codex.cmd", "codex.exe", "codex.ps1"):
        found = shutil.which(name)
        if found:
            return found
    raise SystemExit("codex CLI が見つかりません（PATH を確認してください）")


def run_codex(args: list[str], prompt: str, cwd: Path) -> dict:
    p = subprocess.run(
        [codex_exe(), *args],
        cwd=str(cwd),
        input=prompt,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=TIMEOUT_SEC,
    )
    text, commands, thread_id = "", [], None
    for line in p.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            v = json.loads(line)
        except Exception:
            continue
        if v.get("type") == "thread.started":
            thread_id = v.get("thread_id")
        if v.get("type") == "item.completed":
            it = v["item"]
            if it.get("type") == "agent_message":
                text += it.get("text") or ""
            elif it.get("type") == "command_execution":
                commands.append((it.get("command") or "")[:80])
    return {
        "exit": p.returncode,
        "text": text,
        "commands": commands,
        "thread_id": thread_id,
        "stderr": p.stderr[-400:],
    }


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="unicrew-codexverify-"))
    ws = tmp / "workspace"
    outside = tmp / "appdata" / "avatars"
    ws.mkdir(parents=True)
    outside.mkdir(parents=True)

    image = outside / "screenshot-verify.png"
    word = make_secret_image(image)

    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str) -> None:
        results.append((name, ok, detail))
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  … {detail}")

    print(f"作業場  : {tmp}")
    print(f"合言葉  : {word}（画像のピクセルにしか無い）")
    print("-" * 78)

    # 1. AcceptEdits 新規
    print("1) AcceptEdits の新規セッション")
    a = codex_args("accept", "--cd", str(ws))
    r = run_codex(a, "1+1は？数字だけ答えて。", ws)
    check("AcceptEdits 新規", r["exit"] == 0 and "2" in r["text"],
          f"exit={r['exit']} text={r['text'][:40]!r}")

    # 2. Plan 新規（旧実装はここで exit 2）
    print("2) Plan の新規セッション（旧実装は exit 2 で即死していた）")
    a = codex_args("plan", "--cd", str(ws))
    r_plan = run_codex(a, "1+1は？数字だけ答えて。", ws)
    check("Plan 新規", r_plan["exit"] == 0 and "2" in r_plan["text"],
          f"exit={r_plan['exit']} text={r_plan['text'][:40]!r} err={r_plan['stderr'][:80]!r}")

    # 3. Plan は本当に書けないか
    print("3) Plan で書き込みを頼む（本当に止まるか）")
    danger = ws / "danger.txt"
    danger.unlink(missing_ok=True)
    a = codex_args("plan", "--cd", str(ws))
    r = run_codex(a, f"{ws} に danger.txt というファイルを作って HELLO と書いて。", ws)
    check("Plan は書き込みを拒む", not danger.exists(),
          f"danger.txt は{'作られてしまった' if danger.exists() else '作られなかった'}")

    # 4. Plan の resume（旧実装はここでも exit 2）
    print("4) Plan の resume（旧実装は --sandbox が無くて exit 2）")
    if r_plan["thread_id"]:
        a = codex_args("plan", "--resume", r_plan["thread_id"])
        r = run_codex(a, "さっきの答えに1を足した数字だけ答えて。", ws)
        check("Plan resume", r["exit"] == 0 and "3" in r["text"],
              f"exit={r['exit']} text={r['text'][:40]!r} err={r['stderr'][:80]!r}")
    else:
        check("Plan resume", False, "2 の thread_id が取れなかったので測れていない")

    # 5. 画像添付
    print("5) 画像添付（ワークスペースの外にある画像）")
    a = codex_args("accept", "--cd", str(ws), "--image", str(image))
    r = run_codex(a, "この画像に書いてある単語をそのまま1つだけ答えて。説明は不要。", ws)
    check("画像が届く", word in r["text"],
          f"text={r['text'][:60]!r}")
    check("ファイルを開きに行っていない", not r["commands"],
          f"実行したコマンド={len(r['commands'])}件")

    shutil.rmtree(tmp, ignore_errors=True)

    print("-" * 78)
    failed = [n for n, ok, _ in results if not ok]
    if failed:
        print(f"FAIL: {len(failed)}件 … {failed}")
        return 1
    print(f"PASS: {len(results)}件すべて通過")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
