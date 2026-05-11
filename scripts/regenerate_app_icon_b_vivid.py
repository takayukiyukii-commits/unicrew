"""B 系統（layered light ribbons / luminous flow）を **発色強化 + ネイティブ透過** で 3 パターン再生成。

- gpt-image-1 の `background: "transparent"` を使い、後処理ゼロで真の alpha PNG。
- B の世界観（流れる光・クルー感）を維持しつつ、彩度と明度を底上げ。
- 32×32 でも判別できるよう、リボンを少なめ・太めに調整。

3 パターン:
  G. Vibrant Aurora Ribbons     — 鮮やかなオーロラリボン（cyan/magenta/violet 強発色）
  H. Neon Light Streams         — ネオン光線が交差し crew を形作る（コントラスト最大）
  I. Glowing Aurora Cluster     — 複数の発光オーブとリボンの混成（B + 光球）
"""
from __future__ import annotations
import argparse
import base64
import json
import os
import re
import sys
import urllib.request
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "public" / "brand" / "vivid2"
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
    "Premium abstract icon for an app called UNICREW (a personal AI crew in 5 "
    "minutes). VISUAL STYLE: layered flowing translucent light ribbons that "
    "weave together to form a cohesive crew formation, building on the "
    "previous 'aurora ribbons' direction but with **MAXIMUM SATURATION** and "
    "luminous high-contrast colors. No dark muddy regions. The ribbons should "
    "glow with their own light against a pure transparent background. "
    "Designed to read clearly at 32x32 px in OS taskbar — bold, simple "
    "silhouette, ribbons thick enough to survive shrinkage. "
    "Self-contained shape on a TRANSPARENT background (no backdrop, no "
    "atmosphere). Pure abstract geometry, no mascot, no characters, no text."
)

JOBS = [
    {
        "key": "G",
        "label": "Pattern G: Vibrant Aurora Ribbons",
        "prompt": (
            CONSTRAINTS
            + " === Concept G: Three to four bold flowing light ribbons "
            "weaving together in a gentle S-curve. Each ribbon is a different "
            "highly saturated hue: electric cyan (#06B6D4), vivid magenta "
            "(#EC4899), violet (#8B5CF6), and a touch of bright amber "
            "(#F59E0B). Smooth gaussian glow emanating from each ribbon, "
            "translucent overlap creates secondary glowing colors. The "
            "composition feels like a small concentrated aurora sample. "
            "Centered, balanced, friendly."
        ),
    },
    {
        "key": "H",
        "label": "Pattern H: Neon Light Streams Crew",
        "prompt": (
            CONSTRAINTS
            + " === Concept H: Multiple bold neon light streams (4-5) "
            "arcing from a central point and radiating outward, like a small "
            "explosion of synchronized light. Pure neon colors: hot pink "
            "(#FF0080), electric blue (#0080FF), lime green (#00FF80), and "
            "bright yellow (#FFE500). Hard glowing edges with strong specular "
            "highlights. Reads as a chunky bold mark even at 32px. The "
            "streams converge then radiate, suggesting energy and harmony."
        ),
    },
    {
        "key": "I",
        "label": "Pattern I: Glowing Aurora Cluster",
        "prompt": (
            CONSTRAINTS
            + " === Concept I: A blend of B's two hallmark elements at peak "
            "saturation: 2-3 luminous spherical orbs of different sizes "
            "floating in formation, with vivid translucent ribbons of light "
            "weaving through them connecting them as one crew. Orbs use "
            "saturated cyan + magenta + violet, ribbons use brighter "
            "high-contrast versions of the same. Each orb has a strong inner "
            "glow. Symmetric and centered. The mark feels like a constellation "
            "made of pure colored light."
        ),
    },
]


def gen_one(prompt: str, out_path: Path, key: str) -> bool:
    body = json.dumps(
        {
            "model": "gpt-image-1",
            "prompt": prompt,
            "size": "1024x1024",
            "quality": "high",
            "n": 1,
            "background": "transparent",
            "output_format": "png",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid.uuid4()),
        },
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    items = data.get("data", [])
    if not items:
        print(f"  [FAIL] no images returned: {str(data)[:300]}")
        return False
    b64 = items[0].get("b64_json")
    if not b64:
        print(f"  [FAIL] no b64: {str(items[0])[:200]}")
        return False
    out_path.write_bytes(base64.b64decode(b64))
    return True


def write_preview() -> None:
    rows: list[str] = []
    for job in JOBS:
        fname = f"app-icon__{job['key']}.png"
        rows.append(
            f'<div class="row">\n'
            f'  <div class="label"><strong>{job["label"]}</strong></div>\n'
            f'  <div class="sizes">\n'
            + "".join(
                f'    <div class="box light"><img src="{fname}" width="{s}" height="{s}" /><div class="size">{s}px / light</div></div>\n'
                f'    <div class="box dark"><img src="{fname}" width="{s}" height="{s}" /><div class="size">{s}px / dark</div></div>\n'
                for s in (32, 64, 128, 256)
            )
            + "  </div>\n</div>\n"
        )
    html = (
        "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\" />\n"
        "<title>UNICREW B-vivid icon preview (G/H/I)</title>\n"
        "<style>\n"
        "* { box-sizing: border-box; }\n"
        "body { margin: 0; padding: 28px; background: #1f2937; color: #e2e8f0; font-family: -apple-system, system-ui, sans-serif; }\n"
        "h1 { font-size: 20px; margin: 0 0 24px; }\n"
        ".row { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 18px; margin-bottom: 18px; }\n"
        ".label { font-size: 13px; margin-bottom: 12px; color: #cbd5e1; }\n"
        ".sizes { display: grid; grid-template-columns: repeat(8, 1fr); gap: 10px; }\n"
        ".box { display: flex; flex-direction: column; align-items: center; padding: 10px; border-radius: 8px; }\n"
        ".box.light { background: #fafafa; color: #475569; }\n"
        ".box.dark { background: #0a0a0a; color: #94a3b8; }\n"
        ".size { font-size: 10px; margin-top: 6px; font-family: monospace; }\n"
        "img { display: block; image-rendering: -webkit-optimize-contrast; }\n"
        "</style></head><body>\n"
        "<h1>UNICREW B-vivid Pattern G / H / I（B 系統で発色強化・ネイティブ透過）</h1>\n"
        + "".join(rows)
        + "</body></html>\n"
    )
    (OUT_DIR / "index.html").write_text(html, encoding="utf-8")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    key = load_openai_key()
    successes = 0
    for job in JOBS:
        out_path = OUT_DIR / f"app-icon__{job['key']}.png"
        print(f"[generate] {out_path.name}")
        if gen_one(job["prompt"], out_path, key):
            print(f"  [OK] {out_path.name} ({out_path.stat().st_size:,} bytes)")
            successes += 1
        else:
            print(f"  [FAIL] {out_path.name}")
    write_preview()
    print(f"\n=== Summary === success: {successes}/{len(JOBS)}")
    return 0 if successes == len(JOBS) else 1


if __name__ == "__main__":
    sys.exit(main())
