/**
 * 添付つきメッセージの本文を組み立てる。
 *
 * # なぜ独立した関数なのか
 *
 * ここは 2026-05-18 と 2026-09-01 の2回、同じ症状（AI が添付画像を見られない）で
 * 直している場所。1回目の修正は `npx tsc --noEmit` だけを「検証」として出荷し、
 * 実際には106日間ずっと壊れたままだった。
 * 二度と型チェックだけで通さないように、送信処理から切り離して
 * テストできる形にしてある。
 *
 * # 役割分担
 *
 * - 画像そのもの: `agentSend` が base64 の image ブロックとして CLI に渡す（Claude 経路）
 * - この関数: 添付を「名前とパスで呼べるようにするラベル」を本文に足す。
 *   画像を直接受け取れないプロバイダ用のフォールバックも兼ねる。
 *
 * # 🚨 CLI 固有の道具名を書かないこと
 *
 * 旧実装は「Read ツールで開いてください」と書いていた。`Read` を持つのは
 * Claude Code だけで、UNICREW が載せている他のプロバイダには存在しない。
 *
 * ただし「存在しない道具名を書くと必ず失敗する」は **誤り**（2026-09-01 実測で否定）。
 * codex 0.150.1 は旧文面でも道具名を無視して自前の手段で画像を開き、正答した。
 * つまりこれは不具合の原因ではなく、**当てにできない指示**というだけ。
 * モデルの気の利きに寄りかかる書き方をやめる、という意味でここは道具名を持たない。
 */

export interface PromptAttachment {
  kind: "image" | "file";
  name: string;
  path: string;
}

/** 画像用の指示文。道具名を含まない。 */
export const IMAGE_NOTE =
  "上記の画像は、テキストとしてではなく画像として内容を確認したうえで回答してください。画像が直接見えていない場合のみ、上記のパスのファイルを開いてください。";

/** 書類用の指示文。道具名を含まない。 */
export const DOC_NOTE =
  "上記の添付ファイルを開いて中身を読んだうえで回答してください。";

export function buildAttachmentPrompt(
  text: string,
  attachments: PromptAttachment[],
): string {
  const imgs = attachments.filter((a) => a.kind === "image");
  const docs = attachments.filter((a) => a.kind !== "image");

  const lines: string[] = [];
  imgs.forEach((a, n) =>
    lines.push(
      `添付画像${imgs.length > 1 ? ` ${n + 1}` : ""}（${a.name}）: ${a.path}`,
    ),
  );
  docs.forEach((a, n) =>
    lines.push(
      `添付ファイル${docs.length > 1 ? ` ${n + 1}` : ""}（${a.name}）: ${a.path}`,
    ),
  );

  const notes: string[] = [];
  if (imgs.length > 0) notes.push(IMAGE_NOTE);
  if (docs.length > 0) notes.push(DOC_NOTE);

  const note = notes.length ? "\n\n" + notes.join("\n") : "";
  return [text, ...lines].filter(Boolean).join("\n\n") + note;
}
