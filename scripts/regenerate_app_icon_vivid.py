"""タスクバー視認性を最重視した抽象アプリアイコンを 3 パターン再生成。

要件:
  - 32×32 でも判別可能なボールド/シンプルなシルエット
  - 高彩度（暗い色を避ける）
  - 自己完結（透明 or 明るい off-white 背景でも生きる形）
  - 抽象（マスコット/文字なし）
  - UNICREW = AI クルー の世界観は維持

3 パターン（全部「発色」軸の別解）:
  D. Vibrant Overlapping Discs   — Venn/オリンピック調の重なる発光ディスク
  E. Bold Gradient Orb           — 単一の大きなグラデーション球（発色のショーケース）
  F. Geometric Crest             — 幾何学パッチワークの紋章タイプ（フラット高コントラスト）
"""
from __future__ import annotations
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "public" / "brand" / "vivid"
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
        raise SystemExit("OpenAI API key not found")
    return m.group(1)


CONSTRAINTS = (
    "Designed for OS taskbar visibility — must read clearly at 32x32 px. "
    "Bold simple silhouette, vivid saturated colors, no dark muddy regions, "
    "no fine details that disappear when shrunk. Pure abstract geometry. "
    "No mascot, no characters, no text whatsoever. Self-contained shape on "
    "a clean off-white (#FAFAFA) backdrop so it can be cropped later. "
    "Icon for an app called UNICREW which gives anyone a personal AI crew "
    "in 5 minutes. Modern, premium, friendly, instantly recognizable."
)

JOBS = [
    {
        "key": "D",
        "label": "Pattern D: Vibrant Overlapping Discs",
        "prompt": (
            CONSTRAINTS
            + " === Concept D: 3 to 4 fully saturated luminous discs (perfect circles) "
            "overlapping in a Venn-diagram / Olympic-rings style, with smooth "
            "color-blend in the overlap regions. Color palette: electric cyan "
            "(#06B6D4), vivid magenta-pink (#EC4899), violet (#8B5CF6), and "
            "warm amber (#F59E0B). Each disc has a soft inner glow but solid "
            "saturated body. The composition reads as a small circular cluster, "
            "balanced and friendly. No outlines — color only."
        ),
    },
    {
        "key": "E",
        "label": "Pattern E: Bold Gradient Orb",
        "prompt": (
            CONSTRAINTS
            + " === Concept E: A single bold spherical orb dominating the canvas, "
            "filled with a smooth multi-stop gradient that rotates around the hue "
            "wheel: electric blue (#3B82F6) → cyan (#22D3EE) → magenta (#EC4899) → "
            "amber-orange (#F59E0B). High specular highlight on the upper-left. "
            "Optional: a smaller satellite orb in violet adjacent to it, "
            "suggesting a crew. Glossy, candy-bright, like a 3D rendered object."
        ),
    },
    {
        "key": "F",
        "label": "Pattern F: Geometric Crest",
        "prompt": (
            CONSTRAINTS
            + " === Concept F: A flat geometric crest assembled from 4-6 large "
            "triangular and hexagonal facets that interlock into a single icon "
            "shape (like a bold abstract crest or shield). Each facet is a solid "
            "saturated color: cyan (#22D3EE), violet (#8B5CF6), pink (#EC4899), "
            "lime (#84CC16), amber (#F59E0B). Clean hard edges, flat 2D, no "
            "gradient inside facets. Reads instantly as a chunky bold mark."
        ),
    },
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quality", default="high", choices=["low", "medium", "high"])
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    key = load_openai_key()
    env = os.environ.copy()
    env["OPENAI_API_KEY_VERIFIED"] = key
    env["OPENAI_API_KEY"] = key

    successes: list[Path] = []
    failures: list[tuple[str, str]] = []
    for job in JOBS:
        out_path = OUT_DIR / f"app-icon__{job['key']}.png"
        cmd = [
            sys.executable,
            str(GPT_SCRIPT),
            "--prompt",
            job["prompt"],
            "--output",
            str(out_path),
            "--size",
            "1024x1024",
            "--quality",
            args.quality,
        ]
        print(f"[generate] {out_path.name}", flush=True)
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            failures.append((out_path.name, (r.stderr or r.stdout)[-300:]))
            print(f"  [FAIL] {out_path.name}")
        else:
            successes.append(out_path)
            print(f"  [OK] {out_path.name} ({out_path.stat().st_size:,} bytes)")

    write_preview()
    print(
        f"\n=== Summary === success: {len(successes)} / fail: {len(failures)}"
    )
    return 0 if not failures else 1


def write_preview() -> None:
    """各画像を 32 / 64 / 128 / 256 / 1024 で並べ、明背景・暗背景の両方で見える比較ページ。"""
    rows: list[str] = []
    for job in JOBS:
        fname = f"app-icon__{job['key']}.png"
        rows.append(
            f"<div class=\"row\">\n"
            f"  <div class=\"label\"><strong>{job['label']}</strong></div>\n"
            f"  <div class=\"sizes\">\n"
            + "".join(
                f"    <div class=\"box light\"><img src=\"{fname}\" width=\"{s}\" height=\"{s}\" /><div class=\"size\">{s}px / light</div></div>\n"
                f"    <div class=\"box dark\"><img src=\"{fname}\" width=\"{s}\" height=\"{s}\" /><div class=\"size\">{s}px / dark</div></div>\n"
                for s in (32, 64, 128, 256)
            )
            + f"  </div>\n"
            f"</div>\n"
        )
    html = (
        "<!doctype html>\n<html lang=\"ja\"><head><meta charset=\"utf-8\" />\n"
        "<title>UNICREW vivid icon preview</title>\n"
        "<style>\n"
        "* { box-sizing: border-box; }\n"
        "body { margin: 0; padding: 28px; background: #1f2937; color: #e2e8f0; font-family: -apple-system, system-ui, sans-serif; }\n"
        "h1 { font-size: 20px; margin: 0 0 24px; }\n"
        ".row { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 18px 18px 24px; margin-bottom: 18px; }\n"
        ".label { font-size: 13px; margin-bottom: 12px; color: #cbd5e1; }\n"
        ".sizes { display: grid; grid-template-columns: repeat(8, 1fr); gap: 10px; }\n"
        ".box { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 10px; border-radius: 8px; }\n"
        ".box.light { background: #fafafa; color: #475569; }\n"
        ".box.dark { background: #0a0a0a; color: #94a3b8; }\n"
        ".size { font-size: 10px; margin-top: 6px; font-family: monospace; }\n"
        "img { display: block; image-rendering: -webkit-optimize-contrast; }\n"
        "</style></head><body>\n"
        "<h1>UNICREW Vivid Icon — Pattern D / E / F（タスクバー視認性比較）</h1>\n"
        + "".join(rows)
        + "</body></html>\n"
    )
    (OUT_DIR / "index.html").write_text(html, encoding="utf-8")
    print(f"[wrote] {OUT_DIR / 'index.html'}")


if __name__ == "__main__":
    sys.exit(main())
