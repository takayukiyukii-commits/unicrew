/**
 * ターミナルの AI が「作業を終えた（または確認待ちで止まった）」ことを、出力の止まり方で見分ける。
 *
 * ターミナルの中の AI（Claude Code / Codex など）は道具の呼び出しを外に教えてくれない。
 * ただ、働いている間は考え中の表示が出力を流し続け、終わると出力がぴたりと止まる。
 * そこで「しばらく出力が続いた → 一定時間静かになった」を1回の作業の終わりとみなす。
 *
 * - minWorkMs より短い出力（打った文字の表示・ちょっとした再描画）は作業と数えない
 * - quietMs 静かになったら終わりとみなす
 * 時刻は引数で渡す（テストで時間を進められるように）。
 */
export interface WorkDetectorOptions {
  minWorkMs: number;
  quietMs: number;
}

export const DEFAULT_WORK_DETECTOR: WorkDetectorOptions = {
  minWorkMs: 8_000,
  quietMs: 4_000,
};

/** 打鍵のあと、この時間内の出力はエコーとみなす。 */
const ECHO_MS = 400;

export class WorkDetector {
  private burstStart: number | null = null;
  private lastOutput = 0;
  private echoUntil = 0;

  constructor(private readonly opts: WorkDetectorOptions = DEFAULT_WORK_DETECTOR) {}

  /**
   * 利用者が文字を打ったとき。打った文字の表示（エコー）は作業ではないので、
   * 直後の短い間の出力は数えない。長い指示を打ち終えて手を止めただけで
   * 「作業が終わりました」と鳴らさないため。
   */
  input(now: number): void {
    // 打った直後の表示（エコー）だけを数えない。出力のまとまりそのものは捨てない。
    // 🚨 2026-10-07 実測：打鍵でまとまりを捨てる作りにしたら、AI の作業中に次の指示を
    //    打ち込んだだけで作業時間が短く数え直され、完了の知らせが出なくなった
    this.echoUntil = now + ECHO_MS;
  }

  /** 出力が来たとき。 */
  output(now: number): void {
    if (now < this.echoUntil) return;
    if (this.burstStart === null || now - this.lastOutput >= this.opts.quietMs) {
      this.burstStart = now;
    }
    this.lastOutput = now;
  }

  /**
   * 定期的に呼ぶ。作業が終わったと判断した瞬間に1回だけ、作業時間（ms）を返す。
   * それ以外は null。
   */
  tick(now: number): number | null {
    if (this.burstStart === null) return null;
    if (now - this.lastOutput < this.opts.quietMs) return null;
    const worked = this.lastOutput - this.burstStart;
    this.burstStart = null;
    return worked >= this.opts.minWorkMs ? worked : null;
  }
}
