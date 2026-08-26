import { describe, expect, it } from "vitest";
import { extractLastJsonObject } from "./codex-remote";

describe("extractLastJsonObject", () => {
  it("実測: start --json の応答（警告行つき）を拾う", () => {
    // 2026-08-27 実測（codex-cli 0.150.0 / Linux）。警告は grep 除去前の生出力を模す
    const out = [
      "\x1b[2m2026-08-26T23:24:50Z\x1b[0m \x1b[31mERROR\x1b[0m codex_app_server: Codex could not find bubblewrap on PATH.",
      '{"mode":"daemon","status":"connected","serverName":"DESKTOP","environmentId":"env_e_abc","timedOut":false}',
      "",
    ].join("\r\n");
    const j = extractLastJsonObject(out);
    expect(j).not.toBeNull();
    expect(j?.status).toBe("connected");
    expect(j?.environmentId).toBe("env_e_abc");
  });

  it("実測: pair --json の応答を拾う", () => {
    const out =
      '{"pairingCode":"0221846875871","manualPairingCode":"4VPU-CU3B","environmentId":"env_e_abc","expiresAt":1787788661}\n';
    const j = extractLastJsonObject(out);
    expect(j?.manualPairingCode).toBe("4VPU-CU3B");
    expect(j?.expiresAt).toBe(1787788661);
  });

  it("複数 JSON 行があれば最後を返す", () => {
    const out = '{"status":"stopped"}\n{"status":"connected"}\n';
    expect(extractLastJsonObject(out)?.status).toBe("connected");
  });

  it("実測: standalone 導入案内（JSON なし）は null", () => {
    const out = [
      "Install it with:",
      "  curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      "",
      "Then rerun the command you just tried.",
    ].join("\n");
    expect(extractLastJsonObject(out)).toBeNull();
  });

  it("実測: Windows の拒否メッセージ（JSON なし）は null", () => {
    expect(
      extractLastJsonObject(
        "Error: codex app-server daemon lifecycle is only supported on Unix platforms\n",
      ),
    ).toBeNull();
  });

  it("壊れた JSON 風の行は無視する", () => {
    const out = '{not json}\n{"ok":true}\n';
    expect(extractLastJsonObject(out)?.ok).toBe(true);
  });
});
