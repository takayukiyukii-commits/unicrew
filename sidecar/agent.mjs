#!/usr/bin/env node
/**
 * UNICREW agent sidecar
 *
 * Communicates with Tauri main process via stdio (JSON lines).
 * Uses @anthropic-ai/claude-agent-sdk to run a Claude Code-equivalent agent loop
 * in a user-selected workspace.
 *
 * Inputs (stdin, one JSON object per line):
 *   { kind: "user_message", text: string }
 *   { kind: "permission_response", request_id, decision: "allow"|"deny"|"allow_once" }
 *   { kind: "stop" }
 *
 * Outputs (stdout, one JSON object per line):
 *   { kind: "ready" }
 *   { kind: "assistant_text", session_id, text }
 *   { kind: "tool_use", session_id, tool_name, tool_input }
 *   { kind: "tool_result", session_id, tool_name, is_error, content }
 *   { kind: "permission_request", session_id, request_id, tool_name, input }
 *   { kind: "result", session_id, subtype, cost_usd, usage }
 *   { kind: "usage_delta", session_id, input_tokens?, output_tokens?, cache_read_tokens?, cache_creation_tokens? }
 *   { kind: "error", session_id, message }
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const SESSION_ID = process.env.UNICREW_SESSION_ID || "default";
const WORKSPACE = process.env.UNICREW_WORKSPACE || process.cwd();
const MODEL = process.env.UNICREW_MODEL || "claude-sonnet-4-6";
const SYSTEM_PROMPT = process.env.UNICREW_SYSTEM_PROMPT || "";
const AUTH_MODE = process.env.UNICREW_AUTH_MODE || "subscription";

// Subscription（claude.ai OAuth）モードでは ANTHROPIC_API_KEY を必ず外す。
// 渡したまま空文字列だと SDK が API モードに落ちるので、明示的に削除する。
if (AUTH_MODE === "subscription") {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const out = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};

const log = (msg, ...rest) => {
  process.stderr.write(`[sidecar ${SESSION_ID}] ${msg} ${rest.length ? JSON.stringify(rest) : ""}\n`);
};

const numberOr = (v, fallback) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

// Pending permission requests waiting for UI decision
const pendingPermissions = new Map(); // request_id -> resolver

// Async generator that yields user messages as they arrive on stdin
const userMessageQueue = [];
let userMessageResolver = null;
let stopped = false;

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (e) {
    log("invalid JSON on stdin", trimmed);
    return;
  }

  if (obj.kind === "user_message") {
    userMessageQueue.push(obj.text);
    if (userMessageResolver) {
      userMessageResolver();
      userMessageResolver = null;
    }
  } else if (obj.kind === "permission_response") {
    const resolver = pendingPermissions.get(obj.request_id);
    if (resolver) {
      pendingPermissions.delete(obj.request_id);
      resolver(obj.decision);
    }
  } else if (obj.kind === "stop") {
    stopped = true;
    if (userMessageResolver) {
      userMessageResolver();
      userMessageResolver = null;
    }
  }
});

async function* userMessageGenerator() {
  while (!stopped) {
    if (userMessageQueue.length > 0) {
      const text = userMessageQueue.shift();
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
      };
    } else {
      await new Promise((resolve) => {
        userMessageResolver = resolve;
      });
    }
  }
}

// canUseTool callback: ask the UI for permission before tool execution
async function canUseTool(toolName, input, _options) {
  const requestId = randomUUID();
  out({
    kind: "permission_request",
    session_id: SESSION_ID,
    request_id: requestId,
    tool_name: toolName,
    input,
  });
  const decision = await new Promise((resolve) => {
    pendingPermissions.set(requestId, resolve);
  });
  if (decision === "allow" || decision === "allow_once") {
    return { behavior: "allow", updatedInput: input };
  }
  return { behavior: "deny", message: "ユーザーが操作を拒否しました", interrupt: false };
}

async function main() {
  out({ kind: "ready" });
  log("starting", { workspace: WORKSPACE, model: MODEL });

  try {
    const iterator = query({
      prompt: userMessageGenerator(),
      options: {
        cwd: WORKSPACE,
        model: MODEL,
        // Claude Code の標準systemPromptを土台に、キャラペルソナを *append* する。
        // 単体stringにすると Claude Code の挙動（コード規約・ツール段取り・検証癖等）が失われ、
        // Claude.ai ライクなただのチャットに劣化するため要注意。
        systemPrompt: SYSTEM_PROMPT
          ? {
              type: "preset",
              preset: "claude_code",
              append: SYSTEM_PROMPT,
            }
          : { type: "preset", preset: "claude_code" },
        // Claude Code の全ツールセット（Read/Edit/Write/Bash/Glob/Grep/MultiEdit/NotebookEdit/Task 等）
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "default",
        canUseTool,
        includePartialMessages: true,
        // CLAUDE.md / .claude/skills 等の読み込み（user・project 両スコープ）
        settingSources: ["user", "project"],
      },
    });

    for await (const event of iterator) {
      if (stopped) break;

      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            out({
              kind: "assistant_text",
              session_id: SESSION_ID,
              text: block.text,
            });
          } else if (block.type === "tool_use") {
            out({
              kind: "tool_use",
              session_id: SESSION_ID,
              tool_use_id: block.id,
              tool_name: block.name,
              tool_input: block.input,
            });
            // サーバーサイドツール（web_search / web_fetch）は tool_result イベントが
            // 別途流れてこないので、UI 側のバブルが永久に「実行中」になる。
            // 合成 tool_result をすぐに発行して UI を確定させる。
            // 実際の結果は次の assistant テキストに統合されている。
            const serverTools = new Set([
              "web_search",
              "web_fetch",
              "WebSearch",
              "WebFetch",
            ]);
            if (serverTools.has(block.name)) {
              out({
                kind: "tool_result",
                session_id: SESSION_ID,
                tool_use_id: block.id,
                is_error: false,
                content:
                  "(server-side tool: 結果は次のアシスタント応答に統合されています)",
              });
            }
          }
        }
      } else if (event.type === "user" && event.message?.content) {
        // Tool results come back as user messages with tool_result blocks
        for (const block of event.message.content) {
          if (block.type === "tool_result") {
            out({
              kind: "tool_result",
              session_id: SESSION_ID,
              tool_use_id: block.tool_use_id || "unknown",
              is_error: !!block.is_error,
              content: block.content,
            });
          }
        }
      } else if (event.type === "result") {
        // Final usage is authoritative — emit a delta with the totals so the UI
        // settles on the same numbers Claude reports.
        const finalUsage = event.usage ?? null;
        if (finalUsage && typeof finalUsage === "object") {
          out({
            kind: "usage_delta",
            session_id: SESSION_ID,
            input_tokens: numberOr(finalUsage.input_tokens, 0),
            output_tokens: numberOr(finalUsage.output_tokens, 0),
            cache_read_tokens: numberOr(finalUsage.cache_read_input_tokens, 0),
            cache_creation_tokens: numberOr(
              finalUsage.cache_creation_input_tokens,
              0,
            ),
          });
        }
        out({
          kind: "result",
          session_id: SESSION_ID,
          subtype: event.subtype,
          cost_usd: event.cost_usd ?? null,
          usage: finalUsage,
        });
      } else if (event.type === "stream_event") {
        // Forward usage from raw Anthropic stream events.
        // - message_start: initial input tokens (cumulative input incl. cache)
        // - message_delta: running output tokens (cumulative within turn)
        const inner = event.event ?? event;
        if (inner && typeof inner === "object") {
          if (inner.type === "message_start") {
            const u = inner.message?.usage;
            if (u) {
              out({
                kind: "usage_delta",
                session_id: SESSION_ID,
                input_tokens: numberOr(u.input_tokens, 0),
                output_tokens: numberOr(u.output_tokens, 0),
                cache_read_tokens: numberOr(u.cache_read_input_tokens, 0),
                cache_creation_tokens: numberOr(
                  u.cache_creation_input_tokens,
                  0,
                ),
              });
            }
          } else if (inner.type === "message_delta" && inner.usage) {
            out({
              kind: "usage_delta",
              session_id: SESSION_ID,
              output_tokens: numberOr(inner.usage.output_tokens, 0),
            });
          }
        }
      }
    }
  } catch (err) {
    log("agent loop error", err?.message || String(err));
    out({
      kind: "error",
      session_id: SESSION_ID,
      message: err?.message || String(err),
    });
  } finally {
    log("exiting");
    process.exit(0);
  }
}

main();
