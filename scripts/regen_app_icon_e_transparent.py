"""Pattern E の Bold Gradient Orb を **最初から透過 PNG** として再生成。

OpenAI gpt-image API の `background: "transparent"` を使って、ポストプロセス
（rembg や色距離マスク）なしで真の alpha 付き PNG を取得する。これで透過の縁が
壊れない。
"""
from __future__ import annotations
import base64
import json
import os
import re
import sys
import urllib.request
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
KEY_FILE = Path(
    r"C:/Users/takay/OneDrive/デスクトップ/company/API管理/APIキー一覧.md"
)
OUT_PATH = REPO / "public" / "brand" / "app-icon.png"

PROMPT = (
    "Premium abstract icon for an app called UNICREW (a personal AI crew in 5 "
    "minutes). VISUAL: a single bold spherical orb dominating the canvas, "
    "filled with a smooth multi-stop gradient that rotates around the hue "
    "wheel: electric blue (#3B82F6) -> cyan (#22D3EE) -> magenta (#EC4899) -> "
    "amber-orange (#F59E0B). High specular highlight on the upper-left. A "
    "smaller satellite orb in violet adjacent, suggesting a crew. Glossy, "
    "candy-bright, like a 3D rendered object. Bold simple silhouette, vivid "
    "saturated colors, no dark muddy regions, designed to read clearly at "
    "32x32 px in an OS taskbar. Self-contained shape — TRANSPARENT background "
    "(no backdrop color, no atmosphere). Pure abstract geometry, no mascot, "
    "no characters, no text whatsoever."
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


def main() -> int:
    key = load_openai_key()
    body = json.dumps(
        {
            "model": "gpt-image-1",
            "prompt": PROMPT,
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
    print("[generate] gpt-image-1 with background=transparent")
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    items = data.get("data", [])
    if not items:
        raise SystemExit(f"no images returned: {str(data)[:400]}")
    b64 = items[0].get("b64_json")
    if not b64:
        raise SystemExit(f"no b64 image: {str(items[0])[:200]}")
    raw = base64.b64decode(b64)
    OUT_PATH.write_bytes(raw)
    print(f"[saved] {OUT_PATH} ({len(raw):,} bytes)")
    # alpha チェック
    try:
        from PIL import Image

        img = Image.open(OUT_PATH)
        print(f"  mode={img.mode} size={img.size}")
        if img.mode == "RGBA":
            alpha = img.split()[-1]
            hist = alpha.histogram()
            total = sum(hist)
            zero = hist[0]
            full = hist[255]
            mid = total - zero - full
            print(
                f"  alpha=0: {zero/total*100:.1f}% / alpha=255: {full/total*100:.1f}% / mid: {mid/total*100:.1f}%"
            )
    except Exception as e:
        print(f"  (alpha check skipped: {e})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
