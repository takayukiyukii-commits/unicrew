/**
 * 手前に重ねる家具（背景の絵から形を切り出したもの。src は形だけの絵で、色は背景の絵をこの形で切り抜いて出す）。足元の y が base より小さい人＝その家具より奥にいる人を隠す。
 * 🚨 手で書かない。背景の絵を変えたら `python scripts/office_scene_front.py` で作り直す。
 */
export interface SceneFront { name: string; alpha: number; src: string; x: number; y: number; w: number; h: number; base: number }
export const SCENE_FRONT: SceneFront[] = [
  {
    "name": "island0-back",
    "alpha": 1.0,
    "src": "/office/scene/front/00.png",
    "x": 0.27656,
    "y": 0.20556,
    "w": 0.09427,
    "h": 0.03426,
    "base": 0.226
  },
  {
    "name": "island1-back",
    "alpha": 1.0,
    "src": "/office/scene/front/01.png",
    "x": 0.45729,
    "y": 0.20648,
    "w": 0.09375,
    "h": 0.03333,
    "base": 0.226
  },
  {
    "name": "island2-back",
    "alpha": 1.0,
    "src": "/office/scene/front/02.png",
    "x": 0.6375,
    "y": 0.20648,
    "w": 0.13802,
    "h": 0.03333,
    "base": 0.226
  },
  {
    "name": "meeting-chairs-l",
    "alpha": 1.0,
    "src": "/office/scene/front/03.png",
    "x": 0.04896,
    "y": 0.25556,
    "w": 0.03906,
    "h": 0.19722,
    "base": 0.2556
  },
  {
    "name": "meeting-chairs-r",
    "alpha": 1.0,
    "src": "/office/scene/front/04.png",
    "x": 0.1474,
    "y": 0.25556,
    "w": 0.02135,
    "h": 0.19722,
    "base": 0.2556
  },
  {
    "name": "meeting-table",
    "alpha": 1.0,
    "src": "/office/scene/front/05.png",
    "x": 0.08802,
    "y": 0.25556,
    "w": 0.05938,
    "h": 0.19722,
    "base": 0.2556
  },
  {
    "name": "meeting-item",
    "alpha": 1.0,
    "src": "/office/scene/front/06.png",
    "x": 0.03542,
    "y": 0.25556,
    "w": 0.01458,
    "h": 0.06759,
    "base": 0.3231
  },
  {
    "name": "island0-desk",
    "alpha": 1.0,
    "src": "/office/scene/front/07.png",
    "x": 0.25208,
    "y": 0.23981,
    "w": 0.13958,
    "h": 0.10278,
    "base": 0.373
  },
  {
    "name": "island1-desk",
    "alpha": 1.0,
    "src": "/office/scene/front/08.png",
    "x": 0.43542,
    "y": 0.23981,
    "w": 0.13854,
    "h": 0.10278,
    "base": 0.373
  },
  {
    "name": "island2-desk",
    "alpha": 1.0,
    "src": "/office/scene/front/09.png",
    "x": 0.61719,
    "y": 0.23981,
    "w": 0.14219,
    "h": 0.10278,
    "base": 0.373
  },
  {
    "name": "island0-front",
    "alpha": 1.0,
    "src": "/office/scene/front/10.png",
    "x": 0.25156,
    "y": 0.34259,
    "w": 0.1401,
    "h": 0.07593,
    "base": 0.411
  },
  {
    "name": "island1-front",
    "alpha": 1.0,
    "src": "/office/scene/front/11.png",
    "x": 0.43594,
    "y": 0.34259,
    "w": 0.13802,
    "h": 0.07593,
    "base": 0.411
  },
  {
    "name": "island2-front",
    "alpha": 1.0,
    "src": "/office/scene/front/12.png",
    "x": 0.61875,
    "y": 0.34259,
    "w": 0.14062,
    "h": 0.07593,
    "base": 0.411
  },
  {
    "name": "island3-back",
    "alpha": 1.0,
    "src": "/office/scene/front/13.png",
    "x": 0.27031,
    "y": 0.43333,
    "w": 0.0974,
    "h": 0.03426,
    "base": 0.454
  },
  {
    "name": "island4-back",
    "alpha": 1.0,
    "src": "/office/scene/front/14.png",
    "x": 0.45781,
    "y": 0.43611,
    "w": 0.09583,
    "h": 0.03148,
    "base": 0.454
  },
  {
    "name": "island5-back",
    "alpha": 1.0,
    "src": "/office/scene/front/15.png",
    "x": 0.64323,
    "y": 0.43611,
    "w": 0.0974,
    "h": 0.03148,
    "base": 0.454
  },
  {
    "name": "meeting-glass-right",
    "alpha": 0.45,
    "src": "/office/scene/front/16.png",
    "x": 0.19219,
    "y": 0.26019,
    "w": 0.02188,
    "h": 0.19259,
    "base": 0.47
  },
  {
    "name": "meeting-glass-front",
    "alpha": 0.45,
    "src": "/office/scene/front/17.png",
    "x": 0.0,
    "y": 0.45278,
    "w": 0.19635,
    "h": 0.04815,
    "base": 0.5009
  },
  {
    "name": "island3-desk",
    "alpha": 1.0,
    "src": "/office/scene/front/18.png",
    "x": 0.24271,
    "y": 0.46759,
    "w": 0.14688,
    "h": 0.11019,
    "base": 0.608
  },
  {
    "name": "island4-desk",
    "alpha": 1.0,
    "src": "/office/scene/front/19.png",
    "x": 0.43229,
    "y": 0.46759,
    "w": 0.14792,
    "h": 0.11019,
    "base": 0.608
  },
  {
    "name": "island5-desk",
    "alpha": 1.0,
    "src": "/office/scene/front/20.png",
    "x": 0.62031,
    "y": 0.46759,
    "w": 0.14896,
    "h": 0.11019,
    "base": 0.608
  },
  {
    "name": "island3-front",
    "alpha": 1.0,
    "src": "/office/scene/front/21.png",
    "x": 0.24219,
    "y": 0.57778,
    "w": 0.1474,
    "h": 0.07593,
    "base": 0.646
  },
  {
    "name": "island4-front",
    "alpha": 1.0,
    "src": "/office/scene/front/22.png",
    "x": 0.43177,
    "y": 0.57778,
    "w": 0.14844,
    "h": 0.07593,
    "base": 0.646
  },
  {
    "name": "island5-front",
    "alpha": 1.0,
    "src": "/office/scene/front/23.png",
    "x": 0.62187,
    "y": 0.57778,
    "w": 0.1474,
    "h": 0.07593,
    "base": 0.646
  },
  {
    "name": "plant-r",
    "alpha": 1.0,
    "src": "/office/scene/front/24.png",
    "x": 0.92083,
    "y": 0.475,
    "w": 0.07656,
    "h": 0.21574,
    "base": 0.6907
  },
  {
    "name": "lead-desk",
    "alpha": 1.0,
    "src": "/office/scene/front/25.png",
    "x": 0.4151,
    "y": 0.66296,
    "w": 0.17031,
    "h": 0.19722,
    "base": 0.8
  },
  {
    "name": "lead-chair",
    "alpha": 1.0,
    "src": "/office/scene/front/26.png",
    "x": 0.47812,
    "y": 0.775,
    "w": 0.0599,
    "h": 0.07685,
    "base": 0.862
  },
  {
    "name": "door-frame",
    "alpha": 1.0,
    "src": "/office/scene/front/27.png",
    "x": 0.22969,
    "y": 0.7787,
    "w": 0.11562,
    "h": 0.18981,
    "base": 0.94
  },
  {
    "name": "reception",
    "alpha": 1.0,
    "src": "/office/scene/front/28.png",
    "x": 0.34531,
    "y": 0.775,
    "w": 0.1151,
    "h": 0.20648,
    "base": 0.97
  },
  {
    "name": "shelf",
    "alpha": 1.0,
    "src": "/office/scene/front/29.png",
    "x": 0.5901,
    "y": 0.8,
    "w": 0.18021,
    "h": 0.2,
    "base": 0.985
  }
];
