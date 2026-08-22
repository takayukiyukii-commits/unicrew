// 失敗時に画面が案内する手動コマンドが、アプリが実際に実行する導線と一致していることの回帰テスト。
//
// 背景（実害）: 旧実装は Windows で `winget install --id Anthropic.ClaudeCode` を案内していたが、
// アプリ本体は公式ネイティブインストーラを使う。案内どおり winget を手で叩いたユーザーが
// `The process cannot access the file because it is being used by another process` で詰まった。
// macOS 向けの案内 `brew install anthropic-ai/claude-code/claude-code` は tap が消滅していて 404。
//
// 「画面が言うこと」と「アプリがやること」がズレたらここで落ちる。
import { describe, expect, it } from "vitest";
import { manualInstallCommand } from "@/components/InstallFailedFallback";

describe("manualInstallCommand", () => {
  it("Claude は公式インストーラを案内する（winget と 消滅した brew tap は使わない）", () => {
    const win = manualInstallCommand("claude", "windows");
    expect(win).toContain("claude.ai/install.ps1");
    expect(win).not.toContain("winget");

    for (const os of ["mac", "linux", "unknown"] as const) {
      const cmd = manualInstallCommand("claude", os);
      expect(cmd).toContain("claude.ai/install.sh");
      expect(cmd).not.toContain("anthropic-ai/claude-code/claude-code");
    }
  });

  it("Codex は公式インストーラ + npm フォールバックを案内する", () => {
    expect(manualInstallCommand("codex", "windows")).toContain(
      "chatgpt.com/codex/install.ps1",
    );
    const mac = manualInstallCommand("codex", "mac");
    expect(mac).toContain("chatgpt.com/codex/install.sh");
    expect(mac).toContain("@openai/codex");
  });

  it("Gemini は全 OS で npm を案内する（配布が npm のみのため）", () => {
    for (const os of ["windows", "mac", "linux", "unknown"] as const) {
      expect(manualInstallCommand("gemini", os)).toBe(
        "npm install -g @google/gemini-cli",
      );
    }
  });

  it("どの組み合わせでも空文字を返さない", () => {
    for (const product of ["claude", "codex", "gemini"] as const) {
      for (const os of ["windows", "mac", "linux", "unknown"] as const) {
        expect(manualInstallCommand(product, os).trim().length).toBeGreaterThan(0);
      }
    }
  });
});
