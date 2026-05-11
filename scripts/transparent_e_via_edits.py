"""元の Pattern E 画像（vivid/app-icon__E.png）を保ったまま背景だけ抜く。

OpenAI の image **edits** エンドポイント + `background: "transparent"` を使うと、
前景を維持しつつ背景だけ alpha 化できる（ピクセル単位の chroma key より遥かに綺麗）。

入力: public/brand/vivid/app-icon__E.png  ← 採用したいオリジナル
出力: public/brand/app-icon.png            ← 透過版で上書き
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
SRC_PATH = REPO / "public" / "brand" / "vivid" / "app-icon__E.png"
OUT_PATH = REPO / "public" / "brand" / "app-icon.png"
KEY_FILE = Path(
    r"D:/secrets/APIキー一覧.md"
)

PROMPT = (
    "Keep the central glossy orb (electric blue / cyan / magenta / amber "
    "gradient sphere with bright specular highlight) and any smaller satellite "
    "orb EXACTLY as they are — same shape, same colors, same gradient, same "
    "highlight. Do not redesign, do not change the lighting, do not add new "
    "elements. ONLY remove the off-white backdrop and replace it with full "
    "transparency. The output must be a clean PNG with alpha — orb opaque, "
    "everything else fully transparent. Anti-aliased edges around the orb."
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


def build_multipart(fields: list[tuple[str, str]], files: list[tuple[str, Path]]) -> tuple[bytes, str]:
    boundary = f"----edit{uuid.uuid4().hex}"
    eol = b"\r\n"
    buf = bytearray()
    for name, value in fields:
        buf += f"--{boundary}".encode() + eol
        buf += f'Content-Disposition: form-data; name="{name}"'.encode() + eol + eol
        buf += value.encode("utf-8") + eol
    for name, path in files:
        data = path.read_bytes()
        buf += f"--{boundary}".encode() + eol
        buf += (
            f'Content-Disposition: form-data; name="{name}"; filename="{path.name}"'.encode()
            + eol
        )
        buf += b"Content-Type: image/png" + eol + eol
        buf += data + eol
    buf += f"--{boundary}--".encode() + eol
    return bytes(buf), f"multipart/form-data; boundary={boundary}"


def main() -> int:
    if not SRC_PATH.exists():
        raise SystemExit(f"source not found: {SRC_PATH}")
    key = load_openai_key()
    fields = [
        ("model", "gpt-image-1"),
        ("prompt", PROMPT),
        ("size", "1024x1024"),
        ("quality", "high"),
        ("n", "1"),
        ("background", "transparent"),
        ("output_format", "png"),
    ]
    files = [("image", SRC_PATH)]
    body, content_type = build_multipart(fields, files)
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/edits",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": content_type,
            "Idempotency-Key": str(uuid.uuid4()),
        },
    )
    print(f"[edit] {SRC_PATH.name} -> remove backdrop, keep orb")
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    items = data.get("data", [])
    if not items:
        raise SystemExit(f"no images returned: {str(data)[:400]}")
    b64 = items[0].get("b64_json")
    if not b64:
        raise SystemExit(f"no b64: {str(items[0])[:200]}")
    raw = base64.b64decode(b64)
    OUT_PATH.write_bytes(raw)
    print(f"[saved] {OUT_PATH} ({len(raw):,} bytes)")
    try:
        from PIL import Image

        img = Image.open(OUT_PATH)
        print(f"  mode={img.mode} size={img.size}")
        if img.mode == "RGBA":
            a = img.split()[-1]
            hist = a.histogram()
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
