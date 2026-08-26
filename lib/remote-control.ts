/**
 * 公式 Remote Control（`claude remote-control`）連携のロジック。
 *
 * UNICREW は claude CLI を PTY で起動し、その出力からセッション URL を
 * 拾って QR 表示する（= スマホの Claude アプリ / claude.ai から接続できる）。
 * ここは純粋関数のみ（PTY・React に依存しない）。テスト対象。
 */

/**
 * 端末出力から ANSI/OSC エスケープ列を取り除く。
 * - CSI: ESC [ ... 文字
 * - OSC: ESC ] ... (BEL | ESC \)  ← OSC8 ハイパーリンクは中身のURLを残す
 * - その他 ESC 1文字系
 */
export function stripTerminalEscapes(input: string): string {
  return (
    input
      // OSC 8 ハイパーリンク: ESC]8;params;URI (BEL|ST) → URI を残す
      .replace(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, " $1 ")
      // その他 OSC（タイトル設定等）: 丸ごと除去
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // CSI
      .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, "")
      // 残りの単独 ESC + 1文字
      .replace(/\x1b./g, "")
  );
}

/**
 * Remote Control の接続 URL を出力テキストから拾う。
 *
 * URL の正確なパス形式は CLI バージョンで変わりうるため、
 * 「claude.ai ドメインの https URL」を寛容に拾う。
 * 見つからなければ null。複数あれば最後（最新表示）を返す。
 */
export function extractRemoteControlUrl(text: string): string | null {
  const plain = stripTerminalEscapes(text);
  const matches = plain.match(/https:\/\/claude\.ai\/[^\s"'`<>()\[\]]+/g);
  if (!matches || matches.length === 0) return null;
  // 行末の句読点などを削る
  const last = matches[matches.length - 1].replace(/[.,;:!?]+$/, "");
  return last;
}

/** 出力チャンクを溜めて URL を検出する小さなアキュムレータ。 */
export class RemoteControlOutputParser {
  private buf = "";
  private urlValue: string | null = null;

  /** 溜めるのは末尾だけで良い（URL は繰り返し表示される想定） */
  private static readonly MAX_BUF = 32_768;

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > RemoteControlOutputParser.MAX_BUF) {
      this.buf = this.buf.slice(-RemoteControlOutputParser.MAX_BUF);
    }
    const found = extractRemoteControlUrl(this.buf);
    if (!found) return;
    // チャンク境界で URL が切れている可能性: プレーン化したバッファの
    // 「末尾ちょうど」で終わる URL は未確定として保留し、後続の出力
    // （改行・プロンプト等）が来て境界が確定してから採用する。
    const plain = stripTerminalEscapes(this.buf);
    if (plain.endsWith(found)) return;
    this.urlValue = found;
  }

  get url(): string | null {
    return this.urlValue;
  }

  /** ログイン未済など、CLI が案内を出したかの緩い検出（UI のヒント用） */
  get sawLoginHint(): boolean {
    const plain = stripTerminalEscapes(this.buf).toLowerCase();
    return (
      plain.includes("/login") ||
      plain.includes("not signed in") ||
      plain.includes("sign in") ||
      plain.includes("ログイン")
    );
  }
}
