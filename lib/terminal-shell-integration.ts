/**
 * シェル統合（OSC 133 / OSC 7 / OSC 633）の読み取り。
 *
 * シェルが「プロンプトが出た」「コマンドを始めた」「終了コードはこれ」を
 * 端末へ知らせる仕組み（VS Code の統合ターミナルが使っているのと同じもの）。
 * これが入ると、こちらは推測なしに
 *   - 直前のコマンドとその終了コード・所要時間
 *   - いまいるフォルダ（cd に追随）
 *   - 「直前のコマンドの出力だけ」を AI に渡す
 * ができるようになる。
 *
 * 【この実装の立場】
 * 🚨 **こちらからユーザーのシェル設定を書き換えない。** 読み取り専用。
 * 起動の仕方（--rcfile 等）に手を入れると、その人の bash / PowerShell の
 * 起動が静かに変わる。効果より事故の方が大きいので、
 * 「貼り付ける 2〜3 行」を画面で案内し、入れた人にだけ効くようにする。
 * 入れていない人の動作は今までと 1 バイトも変わらない。
 */

export type ShellEvent =
  /** プロンプト表示開始（OSC 133;A） */
  | { kind: "prompt-start" }
  /** 入力受付開始（OSC 133;B） */
  | { kind: "command-input" }
  /** コマンド実行開始（OSC 133;C） */
  | { kind: "command-start" }
  /** コマンド終了（OSC 133;D;<code>） */
  | { kind: "command-end"; exitCode: number | null }
  /** 実行したコマンド行（OSC 633;E;<cmdline>） */
  | { kind: "command-line"; command: string }
  /** 作業ディレクトリ（OSC 7 / OSC 633;P;Cwd=） */
  | { kind: "cwd"; cwd: string };

/** file:// URL からローカルパスを取り出す。取り出せなければ null。 */
export function fileUrlToPath(url: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/.exec(url.trim());
  if (!m) return null;
  let path = m[2];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 壊れた % エスケープはそのまま扱う */
  }
  // Windows の /D:/foo → D:/foo
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

/**
 * 出力に含まれる OSC シーケンスを拾う。
 * 終端は BEL（\x07）でも ST（ESC \）でもよい。
 *
 * 🚨 チャンクの切れ目でシーケンスが割れることがあるので、呼ぶ側は
 * 「未確定の末尾」を次のチャンクの先頭に繋いでから渡すこと（splitPendingOsc）。
 */
export function parseShellEvents(text: string): ShellEvent[] {
  const out: ShellEvent[] = [];
  const re = /\x1b\]([0-9]+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    const body = m[2];
    if (code === "7") {
      const path = fileUrlToPath(body);
      if (path) out.push({ kind: "cwd", cwd: path });
      continue;
    }
    if (code === "133") {
      const [type, ...rest] = body.split(";");
      if (type === "A") out.push({ kind: "prompt-start" });
      else if (type === "B") out.push({ kind: "command-input" });
      else if (type === "C") out.push({ kind: "command-start" });
      else if (type === "D") {
        const raw = rest[0];
        const n = raw === undefined || raw === "" ? NaN : Number(raw);
        out.push({
          kind: "command-end",
          exitCode: Number.isFinite(n) ? n : null,
        });
      }
      continue;
    }
    if (code === "633") {
      const sep = body.indexOf(";");
      const type = sep < 0 ? body : body.slice(0, sep);
      const rest = sep < 0 ? "" : body.slice(sep + 1);
      if (type === "E" && rest) {
        out.push({ kind: "command-line", command: unescape633(rest) });
      } else if (type === "P") {
        const cw = /^Cwd=(.*)$/.exec(rest);
        if (cw && cw[1]) out.push({ kind: "cwd", cwd: cw[1] });
      } else if (type === "A") out.push({ kind: "prompt-start" });
      else if (type === "B") out.push({ kind: "command-input" });
      else if (type === "C") out.push({ kind: "command-start" });
      else if (type === "D") {
        const n = rest === "" ? NaN : Number(rest.split(";")[0]);
        out.push({
          kind: "command-end",
          exitCode: Number.isFinite(n) ? n : null,
        });
      }
    }
  }
  return out;
}

/** VS Code 方式のエスケープ（\xAB 形式）を戻す。 */
function unescape633(s: string): string {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/**
 * チャンクの末尾に「終端がまだ来ていない OSC」があれば、その手前までを
 * 処理対象とし、残りを次回へ持ち越す。
 * 返り値: [今回処理する文字列, 次回へ持ち越す文字列]
 */
export function splitPendingOsc(text: string): [string, string] {
  const start = text.lastIndexOf("\x1b]");
  if (start < 0) return [text, ""];
  const rest = text.slice(start);
  // 終端（BEL か ESC \）が来ていれば持ち越し不要
  if (/\x07|\x1b\\/.test(rest.slice(2))) return [text, ""];
  // 長すぎる持ち越しは捨てる（壊れた出力で無限に溜めない）
  if (rest.length > 4096) return [text, ""];
  return [text.slice(0, start), rest];
}

/** 案内するシェル別の設定スニペット。 */
export type IntegrationShell = "bash" | "zsh" | "powershell";

/**
 * ユーザーが自分の設定ファイルへ貼る行。
 * 🚨 こちらから書き込まない。表示してコピーしてもらうだけ。
 */
export function integrationSnippet(shell: IntegrationShell): string {
  if (shell === "powershell") {
    return [
      "# UNICREW: コマンドの区切りと終了コードを端末へ知らせる（$PROFILE に追記）",
      "function Global:__unicrew_prompt {",
      '  $code = if ($?) { 0 } else { 1 }',
      '  "$([char]27)]133;D;$code$([char]7)" | Write-Host -NoNewline',
      '  "$([char]27)]7;file://$env:COMPUTERNAME/$($PWD.Path -replace \'\\\\\',\'/\')$([char]7)" | Write-Host -NoNewline',
      '  "$([char]27)]133;A$([char]7)" | Write-Host -NoNewline',
      "}",
      "$Global:__unicrew_orig_prompt = $function:prompt",
      "function Global:prompt {",
      "  __unicrew_prompt",
      "  & $Global:__unicrew_orig_prompt",
      "}",
    ].join("\n");
  }
  const rc = shell === "zsh" ? "~/.zshrc" : "~/.bashrc";
  return [
    `# UNICREW: コマンドの区切りと終了コードを端末へ知らせる（${rc} に追記）`,
    "__unicrew_precmd() {",
    "  local code=$?",
    '  printf "\\033]133;D;%s\\007" "$code"',
    '  printf "\\033]7;file://%s%s\\007" "${HOSTNAME:-}" "$PWD"',
    '  printf "\\033]133;A\\007"',
    "}",
    "__unicrew_preexec() {",
    '  printf "\\033]633;E;%s\\007" "$1"',
    '  printf "\\033]133;C\\007"',
    "}",
    shell === "zsh"
      ? "precmd_functions+=(__unicrew_precmd); preexec_functions+=(__unicrew_preexec)"
      : 'PROMPT_COMMAND="__unicrew_precmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
    shell === "bash"
      ? 'trap \'__unicrew_preexec "$BASH_COMMAND"\' DEBUG'
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
