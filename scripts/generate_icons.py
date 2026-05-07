"""暫定アイコン生成スクリプト。本番素材はZUBOLAND発注に差し替え。"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

# UNIPILOT brand: blue gradient with "U" mark
BG = (59, 130, 246)        # blue-500
BG_DARK = (37, 99, 235)    # blue-600
FG = (255, 255, 255)


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # rounded square
    radius = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)
    # subtle gradient via overlay (simulate with darker bottom)
    overlay = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rounded_rectangle(
        [0, int(size * 0.5), size - 1, size - 1],
        radius=radius,
        fill=(*BG_DARK, 80),
    )
    img = Image.alpha_composite(img, overlay)
    d = ImageDraw.Draw(img)
    # "U" mark — using basic primitives so no font dependency
    pad = int(size * 0.27)
    stroke = int(size * 0.13)
    # left bar
    d.rounded_rectangle(
        [pad, pad, pad + stroke, size - pad - int(stroke * 0.4)],
        radius=int(stroke * 0.4),
        fill=FG,
    )
    # right bar
    d.rounded_rectangle(
        [size - pad - stroke, pad, size - pad, size - pad - int(stroke * 0.4)],
        radius=int(stroke * 0.4),
        fill=FG,
    )
    # bottom curve (rectangle with rounded bottom corners)
    bottom_w = size - pad * 2
    bottom_h = int(stroke * 1.1)
    d.rounded_rectangle(
        [pad, size - pad - bottom_h, size - pad, size - pad],
        radius=int(bottom_h * 0.5),
        fill=FG,
    )
    return img


def main() -> None:
    sizes = [
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
    ]
    for name, sz in sizes:
        img = make_icon(sz)
        path = OUT / name
        img.save(path)
        print(f"wrote {path} ({sz}x{sz})")

    # ICO (multi-size embedded)
    ico_path = OUT / "icon.ico"
    base = make_icon(256)
    base.save(ico_path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"wrote {ico_path}")

    # ICNS via Pillow is not natively supported; reuse PNG as placeholder
    icns_path = OUT / "icon.icns"
    base.save(icns_path.with_suffix(".png"))  # safety
    base.save(icns_path)
    print(f"wrote {icns_path} (placeholder; macOS build may need real .icns)")


if __name__ == "__main__":
    main()
