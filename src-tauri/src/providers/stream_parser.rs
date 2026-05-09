//! `claude --output-format stream-json` の出力を `NormalizedEvent` に変換する。
//!
//! claude CLI の stream-json 仕様（公式 cli.js より、2026-05 時点）:
//!
//! ```text
//! {"type":"system","subtype":"init", session_id, model, ...}
//! {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
//! {"type":"assistant","message":{"id":..,"content":[{type:"text",text}|{type:"tool_use",id,name,input}], "usage":{...}}}
//! {"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id","content","is_error"}]}}
//! {"type":"stream_event","event":{type:"content_block_delta", delta:{type:"text_delta",text}}}  // --include-partial-messages 時のみ
//! {"type":"result","subtype":"success", result, total_cost_usd, usage, session_id, num_turns, ...}
//! ```
//!
//! 本パーサーは行単位 JSON を受け取って `Vec<NormalizedEvent>` を返す
//! （1行が複数の React イベントに分解されることがあるため Vec）。

use crate::providers::types::NormalizedEvent;
use serde_json::Value;

/// 1行の stream-json を 0..n 個の NormalizedEvent に変換する。
pub fn parse_line(session_id: &str, line: &str) -> Vec<NormalizedEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let v: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return vec![NormalizedEvent::Error {
                session_id: session_id.to_string(),
                message: format!("stream-json parse error: {} line={}", e, line),
            }];
        }
    };

    let event_type = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match event_type {
        "system" => parse_system(session_id, &v),
        "assistant" => parse_assistant(session_id, &v),
        "user" => parse_user(session_id, &v),
        "stream_event" => parse_stream_event(session_id, &v),
        "result" => parse_result(session_id, &v),
        // permission や error は CLI 側で stderr に出るので、stdout には基本来ない
        _ => vec![],
    }
}

fn parse_system(session_id: &str, _v: &Value) -> Vec<NormalizedEvent> {
    // init イベントは UI 側で特別扱いせず、Ready で代替
    vec![NormalizedEvent::Ready {
        session_id: session_id.to_string(),
    }]
}

fn parse_assistant(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    let mut out = Vec::new();
    let Some(message) = v.get("message") else {
        return out;
    };

    if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
        for block in content {
            let block_type = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(text) = block.get("text").and_then(|x| x.as_str()) {
                        out.push(NormalizedEvent::AssistantText {
                            session_id: session_id.to_string(),
                            text: text.to_string(),
                        });
                    }
                }
                "tool_use" => {
                    let tool_use_id = block
                        .get("id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_name = block
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let tool_input = block.get("input").cloned().unwrap_or(Value::Null);
                    out.push(NormalizedEvent::ToolUse {
                        session_id: session_id.to_string(),
                        tool_use_id,
                        tool_name,
                        tool_input,
                    });
                }
                "thinking" => {
                    // 思考ブロックは現状 UI に流さない（オプション）
                }
                _ => {}
            }
        }
    }

    if let Some(usage) = message.get("usage") {
        let input_tokens = usage.get("input_tokens").and_then(|x| x.as_u64());
        let output_tokens = usage.get("output_tokens").and_then(|x| x.as_u64());
        let cache_read_tokens = usage.get("cache_read_input_tokens").and_then(|x| x.as_u64());
        let cache_creation_tokens = usage.get("cache_creation_input_tokens").and_then(|x| x.as_u64());
        if input_tokens.is_some() || output_tokens.is_some() {
            out.push(NormalizedEvent::UsageDelta {
                session_id: session_id.to_string(),
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
            });
        }
    }

    out
}

fn parse_user(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    // user message のうち、`tool_result` 含むものは ToolResult として出す。
    // 通常のユーザー入力は React 側で既に表示しているのでスキップ。
    let mut out = Vec::new();
    let Some(message) = v.get("message") else {
        return out;
    };
    let Some(content) = message.get("content").and_then(|c| c.as_array()) else {
        return out;
    };
    for block in content {
        let block_type = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if block_type == "tool_result" {
            let tool_use_id = block
                .get("tool_use_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = block
                .get("is_error")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let content_val = block
                .get("content")
                .cloned()
                .unwrap_or(Value::Null);
            out.push(NormalizedEvent::ToolResult {
                session_id: session_id.to_string(),
                tool_use_id,
                is_error,
                content: content_val,
            });
        }
    }
    out
}

fn parse_stream_event(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    // --include-partial-messages 時の差分イベント。現状は text_delta だけ拾い AssistantText に流す。
    let Some(event) = v.get("event") else {
        return vec![];
    };
    let event_type = event.get("type").and_then(|x| x.as_str()).unwrap_or("");
    if event_type == "content_block_delta" {
        let Some(delta) = event.get("delta") else {
            return vec![];
        };
        if delta.get("type").and_then(|x| x.as_str()) == Some("text_delta") {
            if let Some(text) = delta.get("text").and_then(|x| x.as_str()) {
                if !text.is_empty() {
                    return vec![NormalizedEvent::AssistantText {
                        session_id: session_id.to_string(),
                        text: text.to_string(),
                    }];
                }
            }
        }
    }
    vec![]
}

fn parse_result(session_id: &str, v: &Value) -> Vec<NormalizedEvent> {
    let subtype = v
        .get("subtype")
        .and_then(|x| x.as_str())
        .unwrap_or("unknown")
        .to_string();
    let cost_usd = v.get("total_cost_usd").and_then(|x| x.as_f64());
    let usage = v.get("usage").cloned();
    vec![NormalizedEvent::Result {
        session_id: session_id.to_string(),
        subtype,
        cost_usd,
        usage,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_assistant_text_block() {
        let line = r#"{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":10,"output_tokens":5}}}"#;
        let events = parse_line("sess1", line);
        assert_eq!(events.len(), 2); // text + usage
        match &events[0] {
            NormalizedEvent::AssistantText { text, .. } => assert_eq!(text, "hello"),
            _ => panic!("expected AssistantText"),
        }
    }

    #[test]
    fn parse_tool_use_block() {
        let line = r#"{"type":"assistant","message":{"id":"msg_2","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls"}}]}}"#;
        let events = parse_line("sess1", line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::ToolUse {
                tool_name,
                tool_use_id,
                ..
            } => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(tool_use_id, "tu_1");
            }
            _ => panic!("expected ToolUse"),
        }
    }

    #[test]
    fn parse_result_event() {
        let line = r#"{"type":"result","subtype":"success","result":"done","total_cost_usd":0.0023,"usage":{"input_tokens":100,"output_tokens":50},"session_id":"abc"}"#;
        let events = parse_line("sess1", line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::Result {
                subtype, cost_usd, ..
            } => {
                assert_eq!(subtype, "success");
                assert_eq!(*cost_usd, Some(0.0023));
            }
            _ => panic!("expected Result"),
        }
    }

    #[test]
    fn parse_tool_result_in_user_message() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file contents","is_error":false}]}}"#;
        let events = parse_line("sess1", line);
        assert_eq!(events.len(), 1);
        match &events[0] {
            NormalizedEvent::ToolResult {
                tool_use_id,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id, "tu_1");
                assert!(!*is_error);
            }
            _ => panic!("expected ToolResult"),
        }
    }
}
