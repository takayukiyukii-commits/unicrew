# -*- coding: utf-8 -*-
"""
AIオフィスの背景の絵（public/office/scene/office-day.webp）から、次の2つを作る。背景の絵を変えたら必ず回す。

  1. 手前に重ねる家具の形（public/office/scene/front/NN.png）と、その場所・前後の順番（lib/office/scene-front.ts）
     ＝社員より手前にある家具を社員の上に重ねると、机の向こうを歩く・椅子に座る、が正しく見える
  2. 歩ける床の地図（lib/office/scene-walkable.ts）
     ＝通り道（lib/office/scene-map.ts）が家具を横切っていないかを、試験（scene-map.test.ts）で調べる

やり方：床の色に近く、かつ「家具の無い床の点」から輪郭をまたがずに届く画素＝床。机の天板は床と同じ色だが、輪郭で囲まれているので床にならない。
使い方: python scripts/office_scene_front.py            （リポジトリの直下で）
        python scripts/office_scene_front.py --check    （作り直しても差が出ないか＝2回目は「変更なし」になるか）
要るもの: Pillow / numpy / scipy
"""
import glob, json, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))).replace("\\", "/")
CHECK = "--check" in sys.argv
im = Image.open(ROOT + "/public/office/scene/office-day.webp").convert("RGB")
a = np.asarray(im).astype(np.int32)
Hh, Ww, _ = a.shape
yy, xx = np.mgrid[0:Hh, 0:Ww]
fx, fy = xx / Ww, yy / Hh

# ── 1) 床：床の色で、家具の無い床の点から届く所
r, g, b = a[..., 0], a[..., 1], a[..., 2]
cand = (r >= 240) & (g >= 188) & (g <= 240) & (b >= 136) & (b <= 210) & ((r - b) >= 48) & ((r - b) <= 112)
lab, _n = ndimage.label(cand)
seeds = [(0.50, 0.435), (0.90, 0.70), (0.20, 0.62), (0.60, 0.69), (0.10, 0.70), (0.42, 0.30), (0.222, 0.3), (0.779, 0.55), (0.6, 0.95), (0.3, 0.99)]
ids = {int(lab[int(sy * Hh), int(sx * Ww)]) for sx, sy in seeds} - {0}
floor = np.isin(lab, list(ids))

# ── 2) じゅうたん（会議室）・敷物（休憩）・足ふき（入口）も歩ける
def near(px, py, tol):
    x, y = int(px * Ww), int(py * Hh)
    c = a[y - 5:y + 5, x - 5:x + 5].reshape(-1, 3)
    return np.all((a >= c.min(0) - tol) & (a <= c.max(0) + tol), axis=2)
carpet = (near(0.035, 0.40, 10) | near(0.185, 0.42, 10) | near(0.10, 0.46, 10)) & (fx < 0.215) & (fy > 0.22) & (fy < 0.50)
rug = (near(0.80, 0.42, 8) | near(0.93, 0.44, 8)) & (fx > 0.78) & (fy > 0.25) & (fy < 0.48)
mat = (fx > 0.255) & (fx < 0.336) & (fy > 0.934)
walk = ndimage.binary_closing(floor | carpet | rug | mat, iterations=1)

rgba = np.asarray(im.convert("RGBA"))
obj = ~walk
items = []  # (name, mask, base)
def add(name, mask, base, alpha=1.0):
    if mask.sum() >= 300: items.append((name, mask, round(float(base), 4), alpha))
def comps(mask, min_area=400):
    lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        m = lab == i
        if m.sum() >= min_area: out.append(m)
    return out
def bottom(m): return (np.where(m.any(axis=1))[0].max() + 1) / Hh
def top(m): return np.where(m.any(axis=1))[0].min() / Hh

body = obj.copy(); body[: int(0.19 * Hh)] = False
# ── 机の島（6つ）：奥の椅子／机と画面／手前の椅子 の3つに分ける
ISL_X = {0: [0.24, 0.40], 1: [0.425, 0.585], 2: [0.61, 0.775]}
ROWS = [dict(y0=0.20, y1=0.425, back=0.230, front=0.403), dict(y0=0.428, y1=0.66, back=0.458, front=0.638)]
used = np.zeros_like(body)
for r, row in enumerate(ROWS):
    for c in range(3):
        box = body & (fx >= ISL_X[c][0]) & (fx <= ISL_X[c][1]) & (fy >= row["y0"]) & (fy <= row["y1"])
        used |= box
        s1 = row["back"] + 10 / 1080
        s2 = row["front"] - 66 / 1080
        add(f"island{r*3+c}-back", box & (fy < s1), row["back"] - 0.004)
        add(f"island{r*3+c}-desk", box & (fy >= s1) & (fy < s2), row["front"] - 0.030)
        add(f"island{r*3+c}-front", box & (fy >= s2), row["front"] + 0.008)
# ── 取りまとめ役の机：机（奥）と椅子（手前）
lead = body & (fx >= 0.415) & (fx <= 0.59) & (fy >= 0.66) & (fy <= 0.86)
used |= lead
chair = lead & (fy >= 0.775) & (fx >= 0.478) & (fx <= 0.538)
add("lead-desk", lead & ~chair, 0.800)
add("lead-chair", chair, 0.862)
# ── 受付と入口：扉の開く所は切り抜く（出入りする人を隠さない）。足ふきは重ねない
rec = body & (fx >= 0.225) & (fx <= 0.46) & (fy >= 0.775) & (fy <= 0.985)
used |= rec
door_hole = (fx >= 0.250) & (fx <= 0.338) & (fy >= 0.800)
add("door-frame", rec & (fx < 0.345) & ~door_hole, 0.94)
add("reception", rec & (fx >= 0.345), 0.970)
used |= body & (fx >= 0.25) & (fx <= 0.34) & (fy >= 0.93)
# ── 納品の棚
sh = body & (fx >= 0.59) & (fx <= 0.77) & (fy >= 0.795)
used |= sh
add("shelf", sh, 0.985)
# ── 会議室：机は手前、椅子は奥（座る人の後ろ）。ガラスの仕切りは手前だが、透けて中の人が見えるようにする
mt = body & (fx <= 0.215) & (fy >= 0.19) & (fy <= 0.50)
used |= mt
inner = (fx >= 0.035) & (fx <= 0.192) & (fy >= 0.255) & (fy <= 0.452)
for m in comps(mt & inner, 200):
    if m.sum() > 6000:
        # 机は、横に座る人より奥に置く（手前にすると、机のそばに座った人の体の半分が消える。2026-11-21 結城さんの指摘）
        add("meeting-table", m & (fx >= 0.088) & (fx <= 0.147), top(m))
        add("meeting-chairs-l", m & (fx < 0.088), top(m))
        add("meeting-chairs-r", m & (fx > 0.147), top(m))
    else:
        add("meeting-item", m, bottom(m))
frame = mt & ~inner
add("meeting-glass-front", frame & (fy > 0.452), 0.5009, 0.45)
add("meeting-glass-right", frame & (fx > 0.192) & (fy <= 0.452) & (fy > 0.26), 0.47, 0.45)
# ── 休憩の一角・観葉植物：区画ごとに、かたまりを1つずつ（壁とつながった部分は重ねない）
rest = body & ~used
BOXES = {"lounge": (fx > 0.785) & (fy > 0.21) & (fy < 0.49), "plant-r": (fx > 0.90) & (fy > 0.44), "plant-l": (fx < 0.115) & (fy > 0.50)}
for name, box in BOXES.items():
    for k in comps(rest & box, 500):
        x1 = (np.where(k.any(axis=0))[0].max() + 1) / Ww; x0 = np.where(k.any(axis=0))[0].min() / Ww
        if (x1 >= 0.999 and (x1 - x0) > 0.2) or bottom(k) - top(k) > 0.45: continue   # 壁
        add(name, k, bottom(k))

# ── 書き出す
front_dir = ROOT + "/public/office/scene/front/"
os.makedirs(front_dir, exist_ok=True)
changed = []
def put(path, data):
    """中身が変わったときだけ書く（--check のときは書かずに差だけ数える）"""
    old = open(path, "rb").read() if os.path.exists(path) else None
    if old == data: return
    changed.append(path.replace(ROOT + "/", ""))
    if not CHECK: open(path, "wb").write(data)
keep = set()
rows = []
for i, (name, m, base, alpha) in enumerate(sorted(items, key=lambda t: (t[2], t[0]))):
    ys = np.where(m.any(axis=1))[0]; xs = np.where(m.any(axis=0))[0]
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    # 形だけを小さな白黒の絵で持つ（絵そのものは背景と同じ物を使い、この形で切り抜いて重ねる＝絵を二重に持たない）
    crop = np.zeros((y1 - y0, x1 - x0, 4), np.uint8)
    crop[..., 3] = np.where(m[y0:y1, x0:x1], 255, 0)
    fn = f"{i:02d}.png"
    import io as _io
    buf = _io.BytesIO(); Image.fromarray(crop).save(buf, format="PNG", optimize=True)
    put(front_dir + fn, buf.getvalue()); keep.add(fn)
    rows.append(dict(name=name, alpha=alpha, src=f"/office/scene/front/{fn}", x=round(x0 / Ww, 5), y=round(y0 / Hh, 5), w=round((x1 - x0) / Ww, 5), h=round((y1 - y0) / Hh, 5), base=base))
ts = "/**\n * 手前に重ねる家具（背景の絵から形を切り出したもの。src は形だけの絵で、色は背景の絵をこの形で切り抜いて出す）。足元の y が base より小さい人＝その家具より奥にいる人を隠す。\n * 🚨 手で書かない。背景の絵を変えたら `python scripts/office_scene_front.py` で作り直す。\n */\nexport interface SceneFront { name: string; alpha: number; src: string; x: number; y: number; w: number; h: number; base: number }\nexport const SCENE_FRONT: SceneFront[] = " + json.dumps(rows, ensure_ascii=False, indent=2) + ";\n"
put(ROOT + "/lib/office/scene-front.ts", ts.encode("utf-8"))
# 歩ける床の地図（240×135 に縮めて、1行ずつ 0/1 の文字にする）
GW, GH = 240, 135
small = np.asarray(Image.fromarray((walk * 255).astype(np.uint8)).resize((GW, GH), Image.BOX)) >= 128
lines = ["".join("1" if v else "0" for v in row) for row in small]
ts2 = "/**\n * 歩ける床の地図（背景の絵から作る。1＝床・じゅうたん／0＝家具・壁）。通り道が家具を横切っていないかの試験で使う。\n * 🚨 手で書かない。`python scripts/office_scene_front.py` で作り直す。\n */\nexport const WALK_W = %d;\nexport const WALK_H = %d;\nexport const WALK_ROWS: string[] = %s;\n/** その場所（0〜1）が歩ける床か */\nexport function isWalkable(x: number, y: number): boolean {\n  const cx = Math.min(WALK_W - 1, Math.max(0, Math.floor(x * WALK_W)));\n  const cy = Math.min(WALK_H - 1, Math.max(0, Math.floor(y * WALK_H)));\n  return WALK_ROWS[cy].charCodeAt(cx) === 49;\n}\n" % (GW, GH, json.dumps(lines, indent=2))
put(ROOT + "/lib/office/scene-walkable.ts", ts2.encode("utf-8"))
for f in glob.glob(front_dir + "*.png"):
    if os.path.basename(f) not in keep:
        changed.append(f.replace(ROOT + "/", "") + "（消す）")
        if not CHECK: os.remove(f)
print(f"手前に重ねる家具 {len(rows)} 個／歩ける床 {round(float(walk.mean()) * 100)}%")
if changed:
    print(("差あり（--check なので書いていない）" if CHECK else "書き換えた") + f": {len(changed)} 件")
    for c in changed[:12]: print("  " + c)
    sys.exit(1 if CHECK else 0)
print("変更なし")
