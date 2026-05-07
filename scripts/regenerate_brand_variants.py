"""UNICREW ブランド画像のパターン比較生成。

3 種類（app-icon / logo-mark / og-card）× 3 パターン（A/B/C）= 9 枚。
- A: Luminous orbs constellation（連結する光の球＝クルー）
- B: Layered light ribbons（重なり合う光のリボン＝オーロラ風）
- C: Crystalline geometric crew（プリズム状の幾何学的クルー）

並列実行はせず順次。各画像 ~30-60秒。

完了後 `public/brand/variants/index.html` に 3×3 比較ページを書き出す。
"""
from __future__ import annotations
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VARIANTS_DIR = REPO / "public" / "brand" / "variants"
GPT_SCRIPT = Path(
    r"C:/Users/takay/.claude/skills/gpt-image2/scripts/gpt_image2.py"
)
KEY_FILE = Path(
    r"C:/Users/takay/OneDrive/デスクトップ/company/API管理/APIキー一覧.md"
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


# 共通の世界観
COMMON_DNA = (
    "Premium abstract brand visual for UNICREW, a desktop app that gives "
    "anyone a personal AI crew in 5 minutes. Smooth color gradient palette: "
    "deep navy (#0F172A) → electric cyan (#22D3EE) → violet (#818CF8). "
    "Modern, minimal, friendly-but-premium. No mascot, no characters, no "
    "human figures, no text unless explicitly requested. Pure abstract "
    "composition. Cosmic depth without being gloomy."
)

# 3 つの視覚的方向性
CONCEPTS = {
    "A": {
        "label": "Pattern A: Luminous Orbs Constellation",
        "description": "光る球が連なり crew を形作る、宇宙的な constellation",
        "core": (
            "VISUAL CONCEPT A — Luminous orbs constellation. A small group of "
            "(3 to 5) glowing spherical orbs of slightly different sizes, "
            "floating in formation, connected by softly glowing thin light "
            "streams that bind them as one cohesive crew. Glass-morphism with "
            "soft inner glow. Subtle volumetric haze around each orb. Symmetric "
            "and centered."
        ),
    },
    "B": {
        "label": "Pattern B: Layered Light Ribbons",
        "description": "重なり合う光のリボン（オーロラ風）が crew のフォーメーションを描く",
        "core": (
            "VISUAL CONCEPT B — Layered light ribbons. Several flowing translucent "
            "ribbons of light overlap and weave together to form an aurora-like "
            "crew formation. Each ribbon is a different hue from the gradient. "
            "Smooth gaussian glow, atmospheric, dreamy yet structured. The "
            "ribbons converge at the center then radiate outward, suggesting "
            "harmony and synchronization."
        ),
    },
    "C": {
        "label": "Pattern C: Crystalline Geometric Crew",
        "description": "プリズム状の幾何学的シャードが交差する、シャープでモダンなクルー",
        "core": (
            "VISUAL CONCEPT C — Crystalline geometric crew. Several faceted "
            "prism / shard shapes (tetrahedrons, hexagonal prisms) interlock "
            "in a tight formation. Each facet refracts the gradient palette. "
            "Sharp clean edges, light reflecting off facets, slight motion blur "
            "trails. Architectural and precise yet cohesive. Modern editorial."
        ),
    },
}

# 出力する 3 種類のフォーマット
TYPES = [
    {
        "key": "app-icon",
        "size": "1024x1024",
        "task": (
            "Output type: APP ICON. Square 1:1. Strongly centered, plenty of "
            "breathing room. Recognizable at 32×32. Dark cosmic background. No "
            "text whatsoever. The mark must hold together when shrunk."
        ),
    },
    {
        "key": "logo-mark",
        "size": "1024x1024",
        "task": (
            "Output type: LOGO MARK on **transparent background** (alpha "
            "channel). The mark is isolated with no backdrop, no atmosphere — "
            "only the mark itself is visible. Centered, generous margin. PNG "
            "with full alpha."
        ),
    },
    {
        "key": "og-card",
        "size": "1536x1024",
        "task": (
            "Output type: SOCIAL OG CARD. Cinematic horizontal hero composition. "
            "Left half: the abstract mark occupies ~40% of the canvas. Right "
            "half: the wordmark 'UNICREW' in clean modern geometric sans-serif "
            "white type, with the Japanese tagline 'あなた専属のAIチームを、5分で。' "
            "below it in smaller cyan type, and a tiny English line "
            "'Claude × Codex × Skills × MCP — without the terminal.' Premium "
            "dark cosmic gradient background."
        ),
    },
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quality", default="high", choices=["low", "medium", "high"])
    args = parser.parse_args()

    VARIANTS_DIR.mkdir(parents=True, exist_ok=True)
    key = load_openai_key()
    env = os.environ.copy()
    env["OPENAI_API_KEY_VERIFIED"] = key
    env["OPENAI_API_KEY"] = key

    successes: list[tuple[str, Path]] = []
    failures: list[tuple[str, str]] = []

    for concept_id, concept in CONCEPTS.items():
        for t in TYPES:
            out_name = f"{t['key']}__{concept_id}.png"
            out_path = VARIANTS_DIR / out_name
            full_prompt = (
                f"{COMMON_DNA}\n\n{concept['core']}\n\n{t['task']}"
            )
            cmd = [
                sys.executable,
                str(GPT_SCRIPT),
                "--prompt",
                full_prompt,
                "--output",
                str(out_path),
                "--size",
                t["size"],
                "--quality",
                args.quality,
            ]
            print(f"[generate] {out_name} ({t['size']}, {args.quality})", flush=True)
            try:
                r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=300)
                if r.returncode != 0:
                    failures.append((out_name, (r.stderr or r.stdout)[-300:]))
                    print(f"  [FAIL] {out_name}", flush=True)
                else:
                    successes.append((out_name, out_path))
                    print(f"  [OK] {out_name} ({out_path.stat().st_size:,} bytes)", flush=True)
            except Exception as e:
                failures.append((out_name, str(e)))
                print(f"  [ERR] {out_name}: {e}", flush=True)

    # 比較ページ
    write_index_html()

    print(f"\n=== Summary === success: {len(successes)} / fail: {len(failures)}")
    for name, err in failures:
        print(f"  FAIL {name}: {err[:200]}")
    return 0 if not failures else 1


def write_index_html() -> None:
    type_keys = [t["key"] for t in TYPES]
    html = ["""<!doctype html>
<html lang=\"ja\">
<head>
<meta charset=\"utf-8\" />
<title>UNICREW ブランド画像 比較（3 タイプ × 3 パターン）</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    background: #0f172a; color: #e2e8f0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: 0.05em; }
  .sub { color: #94a3b8; font-size: 13px; margin-bottom: 28px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 18px;
  }
  .card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 12px;
    overflow: hidden;
    display: flex; flex-direction: column;
  }
  .card-head {
    padding: 10px 12px;
    font-size: 12px; font-weight: 600;
    background: #0f172a;
    border-bottom: 1px solid #334155;
    display: flex; justify-content: space-between; align-items: center;
  }
  .card-head .badge { color: #22d3ee; font-family: monospace; }
  .card-img-wrap {
    background: repeating-conic-gradient(#1f2937 0 25%, #111827 0 50%) 0 0/20px 20px;
    padding: 8px;
    display: flex; align-items: center; justify-content: center;
    min-height: 200px;
  }
  .card-img-wrap img { max-width: 100%; height: auto; display: block; border-radius: 4px; }
  .row-label {
    grid-column: 1 / -1;
    color: #818cf8; font-size: 12px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.1em;
    margin: 8px 0 -6px;
  }
  .legend {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
    margin-bottom: 28px;
  }
  .legend > div {
    background: #1e293b; border: 1px solid #334155; border-radius: 8px;
    padding: 12px 14px; font-size: 12px;
  }
  .legend strong { display: block; color: #22d3ee; font-size: 13px; margin-bottom: 4px; }
  .legend p { margin: 0; color: #cbd5e1; line-height: 1.55; }
</style>
</head>
<body>
<h1>UNICREW ブランド画像 比較</h1>
<div class=\"sub\">3 タイプ（app-icon / logo-mark / og-card）× 3 パターン（A/B/C）= 9 枚</div>

<div class=\"legend\">
"""]
    for cid, c in CONCEPTS.items():
        html.append(
            f'  <div><strong>{c["label"]}</strong><p>{c["description"]}</p></div>\n'
        )
    html.append("</div>\n")

    for tk in type_keys:
        html.append(f'<div class="row-label">{tk}</div>\n')
        html.append('<div class="grid">\n')
        for cid in CONCEPTS:
            fname = f"{tk}__{cid}.png"
            html.append(
                f'  <div class="card">\n'
                f'    <div class="card-head"><span>{tk}</span><span class="badge">Pattern {cid}</span></div>\n'
                f'    <div class="card-img-wrap"><img src="{fname}" alt="{fname}" loading="lazy" /></div>\n'
                f'  </div>\n'
            )
        html.append("</div>\n")

    html.append("</body></html>\n")
    (VARIANTS_DIR / "index.html").write_text("".join(html), encoding="utf-8")
    print(f"\n[wrote] {VARIANTS_DIR / 'index.html'}")


if __name__ == "__main__":
    sys.exit(main())
