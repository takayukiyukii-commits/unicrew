"""
UNICREW ブランド画像 5枚を gpt-image-2 で再生成する一括スクリプト。

API キーはコマンド行に書かず、`API管理/APIキー一覧.md` から読み込む。
順次実行し、5枚揃ったらサマリを print する。

使い方:
    python scripts/regenerate_brand_unicrew.py [--quality high|medium]
"""
from __future__ import annotations
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BRAND_DIR = REPO / "public" / "brand"
GPT_SCRIPT = Path(
    r"C:/Users/takay/.claude/skills/gpt-image2/scripts/gpt_image2.py"
)
KEY_FILE = Path(
    r"D:/secrets/APIキー一覧.md"
)


def load_openai_key() -> str:
    if "OPENAI_API_KEY_VERIFIED" in os.environ:
        return os.environ["OPENAI_API_KEY_VERIFIED"]
    if "OPENAI_API_KEY" in os.environ:
        return os.environ["OPENAI_API_KEY"]
    text = KEY_FILE.read_text(encoding="utf-8")
    m = re.search(r"`OPENAI_API_KEY`:\s*`(sk-[^`]+)`", text)
    if not m:
        raise SystemExit("OpenAI API key not found in API管理/APIキー一覧.md")
    return m.group(1)


# Common visual DNA — keep these stable across all 5 outputs so the brand reads as one set.
DNA = (
    "Abstract premium AI brand visual for UNICREW, a desktop app that gives anyone "
    "a personal AI crew in 5 minutes. Visual concept: a small constellation of "
    "luminous orbs floating in formation, connected by softly glowing thin light "
    "streams that form a cohesive crew. Smooth color gradient from deep navy "
    "through electric cyan into violet (#0F172A → #22D3EE → #818CF8). Glass-morphism, "
    "soft inner glow, subtle volumetric haze. Modern, minimal, friendly-but-premium. "
    "No mascot, no characters, no text unless explicitly requested. Pure abstract "
    "geometric composition. Cosmic depth without being dark or gloomy."
)

JOBS = [
    {
        "out": "app-icon.png",
        "size": "1024x1024",
        "prompt": (
            DNA
            + " === Output: APP ICON. Symmetric composition centered in a square. "
            "Four orbs of slightly different sizes in a constellation pattern, connected "
            "by clean light streams. Plenty of breathing room. Recognizable at 32x32. "
            "Dark cosmic background that holds together as a desktop icon."
        ),
    },
    {
        "out": "logo-mark.png",
        "size": "1024x1024",
        "prompt": (
            DNA
            + " === Output: LOGO MARK on transparent background. The same crew of "
            "luminous connected orbs but isolated as a clean symbol — fully transparent "
            "background, no cosmic backdrop, no atmosphere. The mark itself is the only "
            "visible element. Centered. PNG with alpha channel."
        ),
    },
    {
        "out": "logo-wordmark.png",
        "size": "1536x1024",
        "prompt": (
            DNA
            + " === Output: HORIZONTAL WORDMARK. Left side: the abstract orb-and-light "
            "crew mark (smaller, refined). Right side: the wordmark 'UNICREW' in a "
            "clean modern geometric sans-serif, bright white, generous letter-spacing. "
            "Below the wordmark in much smaller type the Japanese tagline "
            "'あなた専属のAIチームを、5分で。' in light cyan. Pure white background."
        ),
    },
    {
        "out": "favicon-source.png",
        "size": "1024x1024",
        "prompt": (
            DNA
            + " === Output: FAVICON SOURCE. Simplified version of the mark — only 3 "
            "orbs forming a tight triangle with bold thicker connecting strokes. Built "
            "for legibility at 16x16. Centered, square, dark cosmic background. No text."
        ),
    },
    {
        "out": "og-card.png",
        "size": "1536x1024",
        "prompt": (
            DNA
            + " === Output: SOCIAL OG CARD. Cinematic horizontal hero composition. "
            "On the left half: a flowing constellation of orbs and light streams, "
            "occupying ~40% of the canvas. On the right half: the wordmark 'UNICREW' "
            "in clean modern geometric sans-serif white type, with the Japanese tagline "
            "'あなた専属のAIチームを、5分で。' below it, and a smaller English line "
            "'Claude × Codex × Skills × MCP — without the terminal.' Premium dark "
            "cosmic gradient background. 1536×1024."
        ),
    },
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quality", default="high", choices=["low", "medium", "high"])
    parser.add_argument("--only", default=None, help="一部だけ再生成する出力ファイル名")
    args = parser.parse_args()

    BRAND_DIR.mkdir(parents=True, exist_ok=True)
    key = load_openai_key()
    env = os.environ.copy()
    env["OPENAI_API_KEY_VERIFIED"] = key
    env["OPENAI_API_KEY"] = key

    successes: list[tuple[str, Path]] = []
    failures: list[tuple[str, str]] = []

    for job in JOBS:
        if args.only and job["out"] != args.only:
            continue
        out_path = BRAND_DIR / job["out"]
        cmd = [
            sys.executable,
            str(GPT_SCRIPT),
            "--prompt",
            job["prompt"],
            "--output",
            str(out_path),
            "--size",
            job["size"],
            "--quality",
            args.quality,
        ]
        print(f"[generate] {job['out']} ({job['size']}, q={args.quality})", flush=True)
        try:
            r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
            if r.returncode != 0:
                failures.append((job["out"], (r.stderr or r.stdout)[-400:]))
                print(f"  [FAIL] {job['out']}\n{r.stderr[-400:]}", flush=True)
            else:
                successes.append((job["out"], out_path))
                print(f"  [OK] {out_path}", flush=True)
        except Exception as e:
            failures.append((job["out"], str(e)))
            print(f"  [ERR] {job['out']}: {e}", flush=True)

    print(f"\n=== Summary === success: {len(successes)} / fail: {len(failures)}")
    for name, p in successes:
        size = p.stat().st_size if p.exists() else 0
        print(f"  OK  {name}  ({size:,} bytes)")
    for name, err in failures:
        print(f"  FAIL {name}: {err[:200]}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
