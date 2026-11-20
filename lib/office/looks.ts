/** ドット絵の社員見本。画像は全員96px高・透明背景。 */
export interface LookSample { id: string; name: string; image: string; color: string }
export const LOOK_SAMPLES: LookSample[] = [
  { id: "aoi", name: "あおい：藍色ジャケット", image: "/office/crew/aoi.png", color: "#4F46E5" },
  { id: "akane", name: "あかね：お団子と珊瑚色", image: "/office/crew/akane.png", color: "#BE6251" },
  { id: "shigeru", name: "しげる：白髪と深緑ベスト", image: "/office/crew/shigeru.png", color: "#38644B" },
  { id: "sumire", name: "すみれ：黒髪ボブと薄紫", image: "/office/crew/sumire.png", color: "#80609C" },
  { id: "hinata", name: "ひなた：くせ毛と山吹色", image: "/office/crew/hinata.png", color: "#AA7927" },
  { id: "minato", name: "みなと：ポニーテールと青緑", image: "/office/crew/minato.png", color: "#337D87" },
  { id: "kaede", name: "かえで：灰色の髪と手帳", image: "/office/crew/kaede.png", color: "#A45D46" },
  { id: "sora", name: "そら：水色シャツとネクタイ", image: "/office/crew/sora.png", color: "#40759E" },
  { id: "chiyo", name: "ちよ：銀髪と桃色スカーフ", image: "/office/crew/chiyo.png", color: "#A9667F" },
  { id: "itsuki", name: "いつき：眼鏡とオリーブ色", image: "/office/crew/itsuki.png", color: "#647137" },
  { id: "shiori", name: "しおり：長い髪と白ブラウス", image: "/office/crew/shiori.png", color: "#48547D" },
  { id: "haru", name: "はる：巻き毛と朱色ポロ", image: "/office/crew/haru.png", color: "#AF5333" },
];
const deckIds = ["relay", "echo", "folio", "kite", "amber", "mint", "orbit", "tide", "clay", "leaf", "pearl", "dusk"];
const legacyIds = ["navy-short", "pink-bun", "coral-cap", "magenta-bob", "sky-short", "blue-long", "yellow-curly", "orange-spiky", "green-bob", "teal-short", "violet-long", "gray-side"];
/** 保存済みの2世代の見本を読み替える。未知のIDも表示できる。 */
export function lookSample(id: string): LookSample {
  return LOOK_SAMPLES.find((look) => look.id === id) ?? LOOK_SAMPLES[deckIds.indexOf(id)] ?? LOOK_SAMPLES[legacyIds.indexOf(id)] ?? LOOK_SAMPLES[0];
}
