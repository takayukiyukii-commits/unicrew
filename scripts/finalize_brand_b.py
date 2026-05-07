"""Pattern B（Layered Light Ribbons）を本番ブランドアセットに昇格させる。

1. variants/{app-icon,logo-mark,og-card}__B.png をメインへコピー
2. logo-wordmark と favicon-source を B スタイルで新規生成
3. Tauri アイコンと favicon.ico は別ステップで再生成
"""
from __future__ import annotations
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BRAND = REPO / "public" / "brand"
VARIANTS = BRAND / "variants"
GPT_SCRIPT = Path(
    r"C:/Users/takay/.claude/skills/gpt-image2/scripts/gpt_image2.py"
)
KEY_FILE = Path(
    r"C:/Users/takay/OneDrive/デスクトップ/company/API管理/APIキー一覧.md"
)

DNA_B = (
    "Premium abstract brand visual for UNICREW, a desktop app that gives "
    "anyone a personal AI crew in 5 minutes. Smooth color gradient palette: "
    "deep navy (#0F172A) → electric cyan (#22D3EE) → violet (#818CF8). "
    "VISUAL CONCEPT B — Layered light ribbons. Several flowing translucent "
    "ribbons of light overlap and weave together to form an aurora-like "
    "crew formation. Each ribbon is a different hue from the gradient. "
    "Smooth gaussian glow, atmospheric, dreamy yet structured. The ribbons "
    "converge at the center then radiate outward, suggesting harmony and "
    "synchronization. No mascot, no characters, no human figures, no text "
    "unless explicitly requested."
)

NEW_JOBS = [
    {
        "out": "logo-wordmark.png",
        "size": "1536x1024",
        "prompt": (
            DNA_B
            + " === Output: HORIZONTAL WORDMARK. Left side: a small refined "
            "version of the layered ribbon mark, tasteful and balanced. Right "
            "side: the wordmark 'UNICREW' in a clean modern geometric "
            "sans-serif, deep navy ink color, generous letter-spacing. Below "
            "the wordmark in much smaller type the Japanese tagline "
            "'あなた専属のAIチームを、5分で。' in soft cyan. Pure white background "
            "(no cosmic backdrop on this version)."
        ),
    },
    {
        "out": "favicon-source.png",
        "size": "1024x1024",
        "prompt": (
            DNA_B
            + " === Output: FAVICON SOURCE. Heavily simplified version of the "
            "ribbon mark — only 2 to 3 thicker bold ribbons interweaving in a "
            "tight square composition. Built for legibility at 16x16. Centered, "
            "square, dark cosmic background. No text. The ribbons should still "
            "read as ribbons even when scaled down."
        ),
    },
]


def load_openai_key() -> str:
    if "OPENAI_API_KEY_VERIFIED" in os.environ:
        return os.environ["OPENAI_API_KEY_VERIFIED"]
    if "OPENAI_API_KEY" in os.environ:
        return os.environ["OPENAI_API_KEY"]
    text = KEY_FILE.read_text(encoding="utf-8")
    m = re.search(r"`OPENAI_API_KEY`:\s*`(sk-[^`]+)`", text)
    if not m:
        raise SystemExit("OpenAI API key not found")
    return m.group(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quality", default="high", choices=["low", "medium", "high"])
    args = parser.parse_args()

    # Step 1: copy variants -> main
    for kind in ("app-icon", "logo-mark", "og-card"):
        src = VARIANTS / f"{kind}__B.png"
        dst = BRAND / f"{kind}.png"
        if not src.exists():
            print(f"  [missing] {src}")
            continue
        shutil.copy2(src, dst)
        print(f"  [adopt B] {dst.name} ({dst.stat().st_size:,} bytes)")

    # Step 2: generate the missing two
    key = load_openai_key()
    env = os.environ.copy()
    env["OPENAI_API_KEY_VERIFIED"] = key
    env["OPENAI_API_KEY"] = key

    fail = 0
    for job in NEW_JOBS:
        out_path = BRAND / job["out"]
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
        print(f"[generate B] {job['out']} ({job['size']}, {args.quality})", flush=True)
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            print(f"  [FAIL] {job['out']}: {(r.stderr or r.stdout)[-300:]}")
            fail += 1
        else:
            print(f"  [OK] {out_path.name} ({out_path.stat().st_size:,} bytes)")

    print("\nDone. Next: run `npx tauri icon public/brand/app-icon.png` and rebuild favicon.ico.")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
