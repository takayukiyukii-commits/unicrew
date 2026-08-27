/**
 * 外部リンクに計測用パラメータ（UTM）を付ける。
 *
 * なぜ要るか（2026-08-28）:
 *   UNICREW は「DL数」と「起動数」までは数えられていた（lib/telemetry.ts）が、
 *   そこから先——UNI製品や uniLinks へ何人が進んだのか——を数える手段が無かった。
 *   KUZIRA で「DL 60件・アカウント作成 0人」を実測したのと同じ穴が、
 *   UNICREW でも開いたままだった。
 *
 * 🚨 方針: 新しくデータを集めない。
 *   ここでやるのは「リンクに出どころを書き添える」だけ。アプリから何かを
 *   送信するわけではないので、PRIVACY.md も ping の「送るのは3つだけ」も変えない。
 *   計測は送客先（zuboland.jp / *.uni-core.jp）の GA4 が受け取る。
 *   2026-08-28 実測: zuboland.jp の /g/collect は 204（測定ID一致）で稼働中。
 *
 * 🚨 付けてよいのは出どころだけ。install_id・ユーザー名・ワークスペース名など、
 *   個人や端末を指す値は絶対に載せない（URLは送客先のログに残るため）。
 */

/** 送客元。UNICREW から出るリンクは常に "unicrew"。 */
const SOURCE = "unicrew";
/** デスクトップアプリ内からのクリックであることを示す。 */
const MEDIUM = "app";
/** この導線ぜんぶをまとめて見るための名前。 */
const CAMPAIGN = "uni_funnel";

/**
 * 画面のどこから押されたか。**増やすときはここに定義を足す**
 * （呼び出し側で文字列を直書きしない＝集計時に表記ゆれで割れないため）。
 */
export type OutboundPlacement =
  /** 「機能の追加」→ UNI Series の製品カード */
  | "addons_uni"
  /** 「機能の追加」→ UNI Series 下部の uniLinks 帯 */
  | "addons_membership"
  /** UNI製品MCP一括接続モーダルの「APIキー発行」リンク */
  | "mcp_apikey";

/**
 * 外部URLに utm_* を付けて返す。
 *
 * - http/https 以外（相対パス・空文字）はそのまま返す（壊さない）
 * - すでに utm_source が付いている URL は尊重してそのまま返す（二重付与しない）
 * - 既存のクエリ・ハッシュは保持する
 */
export function withTracking(
  url: string,
  placement: OutboundPlacement,
): string {
  if (!url) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url; // 相対パス等はそのまま
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return url;
  if (u.searchParams.has("utm_source")) return url;

  u.searchParams.set("utm_source", SOURCE);
  u.searchParams.set("utm_medium", MEDIUM);
  u.searchParams.set("utm_campaign", CAMPAIGN);
  u.searchParams.set("utm_content", placement);
  return u.toString();
}

/**
 * uniLinks（UNIシリーズ使い放題メンバーシップ）の案内。
 *
 * 🚨 数字は zuboland.jp/unilinks の掲載を実測して写したものだけを置く（2026-08-28 確認）。
 *    販売ページに書かれていないこと（「先着◯名」「限定」等）はここに書かない。
 *    ——実在しない限定を語らないため（表示した条件は必ず守る、が社の基準）。
 */
export const UNILINKS = {
  url: "https://zuboland.jp/unilinks",
  /** 月額（円・税込表記は販売ページに従う） */
  price: 9800,
  /** よく使う製品を単体契約したときの合計（販売ページ掲載値） */
  compare: 17400,
  trial: "14日間無料",
} as const;
