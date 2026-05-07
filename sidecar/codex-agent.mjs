#!/usr/bin/env node
/**
 * UNICREW codex sidecar — Claude sidecar と同じstdio JSONLプロトコル。
 *
 * Tauri 側 (lib.rs) は provider 値で agent.mjs / codex-agent.mjs を切替spawn する。
 * 出力イベントは Claude 側と統一されているため、UI 側の処理は変えなくてよい。
 *
 * Inputs (stdin, JSON-lines):
 *   { kind: "user_message", text }
 *   { kind: "stop" }
 *
 * Outputs (stdout, JSON-lines):
 *   { kind: "ready" }
 *   { kind: "assistant_text", session_id, text }
 *   { kind: "tool_use", session_id, tool_use_id, tool_name, tool_input }
 *   { kind: "tool_result", session_id, tool_use_id, is_error, content }
 *   { kind: "result", session_id, subtype, cost_usd, usage }
 *   { kind: "usage_delta", session_id, input_tokens?, output_tokens?, cache_read_tokens?, cache_creation_tokens? }
 *   { kind: "error", session_id, message }
 */

import { Codex } from "@openai/codex-sdk";
import { createInterface } from "node:readline";

const SESSION_ID = process.env.UNICREW_SESSION_ID || "default";
const WORKSPACE = process.env.UNICREW_WORKSPACE || process.cwd();
const SYSTEM_PROMPT = process.env.UNICREW_SYSTEM_PROMPT || "";

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (...args) =>
  process.stderr.write(
    `[codex-sidecar ${SESSION_ID}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
  );

const codex = new Codex();
let thread = null;
let stopped = false;

function startNewThread() {
  thread = codex.startThread({
    workingDirectory: WORKSPACE,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    log("invalid JSON on stdin", trimmed);
    return;
  }
  if (obj.kind === "user_message") {
    await handleUserMessage(obj.text);
  } else if (obj.kind === "stop") {
    stopped = true;
    process.exit(0);
  }
});

async function handleUserMessage(text) {
  try {
    if (!thread) startNewThread();

    // SYSTEM_PROMPT は Codex SDK の startThread に直接渡せないため、
    // ユーザーメッセージの前に1度だけ「役割設定」として注入する。
    let prompt = text;
    if (SYSTEM_PROMPT && thread.__unipilot_system_injected !== true) {
      prompt = `# あなたへの指示\n${SYSTEM_PROMPT}\n\n# ユーザーからの依頼\n${text}`;
      thread.__unipilot_system_injected = true;
    }

    const { events } = await thread.runStreamed(prompt);
    for await (const event of events) {
      if (stopped) break;
      processEvent(event);
    }
  } catch (err) {
    log("agent loop error", err?.message || String(err));
    out({
      kind: "error",
      session_id: SESSION_ID,
      message: err?.message || String(err),
    });
  }
}

function processEvent(event) {
  if (event.type === "item.completed") {
    const item = event.item;
    if (!item) return;
    switch (item.type) {
      case "agent_message":
        out({
          kind: "assistant_text",
          session_id: SESSION_ID,
          text: item.text,
        });
        return;
      case "reasoning":
        // 推論は表示しない（Claude側もデフォは出さない）
        return;
      case "command_execution":
        // command_execution は Bash 相当
        out({
          kind: "tool_use",
          session_id: SESSION_ID,
          tool_use_id: item.id,
          tool_name: "Bash",
          tool_input: { command: item.command },
        });
        out({
          kind: "tool_result",
          session_id: SESSION_ID,
          tool_use_id: item.id,
          is_error: item.exit_code !== undefined && item.exit_code !== 0,
          content: item.aggregated_output ?? "",
        });
        return;
      case "file_change": {
        // file_change は Edit/Write 相当
        const changes = item.changes ?? [];
        const summary = changes
          .map((c) => `${c.kind}: ${c.path ?? ""}`)
          .join("\n");
        out({
          kind: "tool_use",
          session_id: SESSION_ID,
          tool_use_id: item.id,
          tool_name: "Edit",
          tool_input: { changes },
        });
        out({
          kind: "tool_result",
          session_id: SESSION_ID,
          tool_use_id: item.id,
          is_error: item.status === "failed",
          content: summary,
        });
        return;
      }
      case "mcp_tool_call":
        out({
          kind: "tool_use",
          session_id: SESSION_ID,
          tool_use_id: item.id,
          tool_name: `${item.server}.${item.tool}`,
          tool_input: item.arguments ?? {},
        });
        out({
          kind: "tool_result",
          session_id: SESSION_ID,
          tool_use_id: item.id,
          is_error: !!item.error,
          content: item.error?.message ?? "OK",
        });
        return;
      case "web_search":
        out({
          kind: "tool_use",
          session_id: SESSION_ID,
          tool_use_id: item.id,
          tool_name: "WebSearch",
          tool_input: { query: item.query ?? "" },
        });
        return;
      case "error":
        out({
          kind: "error",
          session_id: SESSION_ID,
          message: item.message ?? "Codex error",
        });
        return;
      default:
        return;
    }
  } else if (event.type === "turn.completed") {
    const usage = event.usage ?? null;
    if (usage && typeof usage === "object") {
      const numberOr = (v, fb) =>
        typeof v === "number" && Number.isFinite(v) ? v : fb;
      out({
        kind: "usage_delta",
        session_id: SESSION_ID,
        input_tokens: numberOr(
          usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens,
          0,
        ),
        output_tokens: numberOr(
          usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens,
          0,
        ),
        cache_read_tokens: numberOr(
          usage.cache_read_input_tokens ?? usage.cached_input_tokens,
          0,
        ),
        cache_creation_tokens: numberOr(
          usage.cache_creation_input_tokens,
          0,
        ),
      });
    }
    out({
      kind: "result",
      session_id: SESSION_ID,
      subtype: "success",
      cost_usd: null,
      usage,
    });
  } else if (event.type === "turn.failed") {
    out({
      kind: "error",
      session_id: SESSION_ID,
      message: event.error?.message ?? "Codex turn failed",
    });
  } else if (event.type === "error") {
    out({
      kind: "error",
      session_id: SESSION_ID,
      message: event.message ?? "Codex stream error",
    });
  }
}

out({ kind: "ready" });
log("starting", { workspace: WORKSPACE });
