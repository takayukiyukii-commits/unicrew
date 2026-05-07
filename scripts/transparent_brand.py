"""Pattern B のブランド画像から暗い宇宙的背景を削って透明 PNG を作る。

戦略:
  - 各ピクセルの最大 RGB 値（=どの色チャンネルでも光ってる量）を見て、
    暗いほど透過、明るいほど不透明にする。これで「光リボン」の表現を
    残しつつ深紺の背景を抜ける。
  - rembg のような重い依存を入れたくないので Pillow だけで完結。

入力: public/brand/logo-mark.png（または指定）
出力: public/brand/logo-mark-transparent.png
     + 派生でアプリアイコン用 (app-icon-transparent.png)
"""
from __future__ import annotations
import argparse
from pathlib import Path
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
BRAND = REPO / "public" / "brand"


def make_transparent(
    src: Path,
    dst: Path,
    soft_distance: int = 90,
    hard_distance: int = 30,
) -> None:
    """4 隅の色を「背景色」として、それから離れたピクセルほど不透明にする。
    背景が暗い／明るいのどちらでも同じロジックで対応できる。

    - dist <= hard_distance → alpha 0（完全透明、背景認定）
    - dist >= soft_distance → alpha 255（完全不透明、前景認定）
    - 間は線形補間で滑らかに（光リボンの薄い縁を活かす）
    """
    import numpy as np

    img = Image.open(src).convert("RGB")
    arr = np.asarray(img, dtype=np.int16)  # 符号付きで差分計算
    h, w = arr.shape[:2]
    # 4 隅の平均色を背景色とする
    corners = np.stack(
        [arr[0, 0], arr[0, w - 1], arr[h - 1, 0], arr[h - 1, w - 1]],
        axis=0,
    )
    bg = corners.mean(axis=0).astype(np.int16)
    # 各ピクセルから背景色までのユークリッド距離
    diff = arr - bg
    dist = np.sqrt((diff * diff).sum(axis=2))
    # 距離 → アルファ
    span = max(1, soft_distance - hard_distance)
    alpha = np.clip((dist - hard_distance) / span, 0, 1) * 255
    alpha = alpha.astype(np.uint8)
    rgba = np.dstack([arr.astype(np.uint8), alpha])
    out = Image.fromarray(rgba, "RGBA")
    out.save(dst, "PNG", optimize=True)
    transp = (alpha == 0).sum() / alpha.size * 100
    fully = (alpha == 255).sum() / alpha.size * 100
    print(
        f"  [transparent] {src.name} -> {dst.name} "
        f"({dst.stat().st_size:,} bytes, transparent={transp:.1f}%, opaque={fully:.1f}%, bg={tuple(bg.tolist())})"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--soft", type=int, default=90, help="この距離以上は完全不透明")
    parser.add_argument("--hard", type=int, default=30, help="この距離以下は完全透明")
    args = parser.parse_args()

    make_transparent(
        BRAND / "logo-mark.png",
        BRAND / "logo-mark-transparent.png",
        args.soft,
        args.hard,
    )
    make_transparent(
        BRAND / "app-icon.png",
        BRAND / "app-icon-transparent.png",
        args.soft,
        args.hard,
    )
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
