"""Bump icon content to fill more of the canvas, then regenerate all sizes."""
from pathlib import Path
from PIL import Image

ICON_DIR = Path(__file__).parent
SRC = ICON_DIR / "icon.png"
TARGET_FILL = 0.99  # content occupies up to 99% of canvas (was 94% / originally ~80%)

def rebuild_master(src_path: Path) -> Image.Image:
    im = Image.open(src_path).convert("RGBA")
    bbox = im.getbbox()
    if not bbox:
        raise SystemExit("icon has no opaque content")
    cropped = im.crop(bbox)
    cw, ch = cropped.size
    canvas_size = max(im.size)
    target = int(canvas_size * TARGET_FILL)
    scale = min(target / cw, target / ch)
    nw, nh = int(cw * scale), int(ch * scale)
    resized = cropped.resize((nw, nh), Image.LANCZOS)
    out = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    out.paste(resized, ((canvas_size - nw) // 2, (canvas_size - nh) // 2), resized)
    return out

def main():
    backup = SRC.with_suffix(".bak.png")
    if not backup.exists():
        Image.open(SRC).save(backup)
        print(f"backup -> {backup.name}")

    master = rebuild_master(SRC)
    master.save(SRC)
    print(f"icon.png   -> {master.size}, fill ~{int(TARGET_FILL*100)}%")

    sizes = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "Square30x30Logo.png": 30,
        "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71,
        "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107,
        "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150,
        "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310,
        "StoreLogo.png": 50,
    }
    for name, size in sizes.items():
        target = ICON_DIR / name
        if target.exists():
            master.resize((size, size), Image.LANCZOS).save(target)
            print(f"{name:<24} -> {size}x{size}")

    ico_path = ICON_DIR / "icon.ico"
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    master.save(ico_path, format="ICO", sizes=ico_sizes)
    print(f"icon.ico   -> {ico_sizes}")

    print("done. icns kept as-is (regenerate on macOS if needed).")

if __name__ == "__main__":
    main()
