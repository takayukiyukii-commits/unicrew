# AIオフィスの絵について

AIオフィスの背景と社員の絵（`public/office/`）の作り方の記録です。絵を足す・作り直すときに読みます。

## 何があるか

| 場所 | 中身 |
|---|---|
| `public/office/scene/office-day.webp` | 部屋の背景（1920×1080・ドット絵・人物なし・文字なし） |
| `public/office/scene/front/NN.png` | 手前に重ねる家具の「形」だけの絵（生成物。下の道具が作る） |
| `public/office/crew/<id>.png` | 社員12人の正面の立ち姿（高さ96） |
| `public/office/crew/<id>-<姿>.png` | 同じ12人の向き・動き（下の表） |

社員の id：aoi akane shigeru sumire hinata minato kaede sora chiyo itsuki shiori haru

| 姿 | 中身 |
|---|---|
| `back` `side` | 後ろ向き・右向き（左向きは反転して使う） |
| `walk-front-1/2` `walk-back-1/2` `walk-side-1/2` | 歩く2コマ |
| `sit-front` `sit-back` `sit-side` | 着席（こちら向き・背中・横向き） |
| `hand` `cheer` | 立って手を挙げる・ガッツポーズ |
| `sit-front-hand` `sit-front-cheer` `sit-back-hand` `sit-back-cheer` | 着席で手を挙げる・ガッツポーズ |

絵の下端の中央が、足元（立ち・歩き・横向きの着席）または腰（こちら向き・背中の着席）です。腕を上げた絵は、そのぶん上に伸びます。
ある姿の絵が無い見本は、近い姿（歩くコマ → 立ち姿 → 正面）に自動で戻ります（`components/office/useOfficeWalk.ts`）。

## 作り方

- 絵は画像生成の AI で作った、このアプリのためのオリジナルです（画像ブリーフ ID：`202611210357-hbu0`）。実在の人物・製品・他社のキャラクターに似せていません。絵に文字・ロゴは入れていません
- 背景の切り分け・大きさ合わせ・縁の掃除は Pillow（最近傍・アルファは 0 か 255）

## 背景の絵を変えたら

```
python scripts/office_scene_front.py          # 手前の家具の形と、歩ける床の地図を作り直す（2回目は「変更なし」になる）
python scripts/office_scene_front.py --check   # 作り直しても差が出ないかだけ見る
```

これが `public/office/scene/front/*.png`・`lib/office/scene-front.ts`・`lib/office/scene-walkable.ts` を作ります（手で書かない）。
席や通路の場所（`lib/office/scene-map.ts`）は絵に合わせて手で決めます。通路が家具をまたいでいないかは `lib/office/scene-map.test.ts` が調べます。

## 社員の見本を足すとき

`lib/office/looks.ts` に1行足し、`public/office/crew/<id>.png`（正面）を置きます。向きや動きの絵は、あるものだけ置けば動きます。
