//! OpenTelemetry 観測性 Phase 1 — 足場のみ。
//!
//! ## なぜ Phase 1 では no-op か
//! - エンドポイント（Honeycomb / Grafana Cloud / 自前 OTLP）の決定がメンテナ要判断
//! - opentelemetry-otlp 系は転送依存（rustls / protobuf）が重く、決定前の取込はバイナリ肥大化要因
//! - そのため「フックと API 形」を先に固定し、依存追加は決定後に `otel` feature で有効化
//!
//! ## API（呼び出し側はこれを使う）
//! - `init()`: アプリ起動時に 1 度呼ぶ。env `OTEL_EXPORTER_OTLP_ENDPOINT` を見て active 判定。
//! - `start_session_span(...)`: agent_start 直前。Drop で自動 close される `SessionSpan` を返す。
//! - `is_active()`: 現在 OTel が有効化されているか。フロントの状態表示用。
//!
//! 実装は std のみで完結。後で `cfg(feature = "otel")` ブロックを足せばそのまま OTLP 送信に切替可。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

static ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, serde::Serialize)]
pub struct OtelStatus {
    pub active: bool,
    pub endpoint: Option<String>,
    pub note: String,
}

/// 起動時 1 回だけ呼ぶ。
///
/// `override_endpoint` に値があればそれを優先し、なければ env `OTEL_EXPORTER_OTLP_ENDPOINT`
/// を見て active 判定する。Phase 2 で settings.json / config.toml から endpoint を渡せるように、
/// API 形を先に確定させておく（あとで破壊変更しないため）。
pub fn init(override_endpoint: Option<&str>) {
    let endpoint: Option<String> = override_endpoint
        .map(|s| s.to_owned())
        .or_else(|| std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok());
    if let Some(ep) = endpoint.as_deref() {
        if !ep.is_empty() {
            ACTIVE.store(true, Ordering::SeqCst);
            // Phase 1: 実送信は未実装。stderr に動作確認ログだけ吐く。
            eprintln!("[unicrew/otel] init: endpoint={} (Phase1 = no-op shim)", ep);
        }
    }
}

pub fn is_active() -> bool {
    ACTIVE.load(Ordering::SeqCst)
}

#[tauri::command]
pub fn observability_status() -> Result<OtelStatus, String> {
    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok();
    Ok(OtelStatus {
        active: is_active(),
        endpoint: endpoint.clone(),
        note: if is_active() {
            "Phase 1: フックは動作中、OTLP 実送信は未実装。endpoint 決定後に依存追加で有効化。"
                .to_string()
        } else {
            "OTel 未設定。env OTEL_EXPORTER_OTLP_ENDPOINT を設定して再起動してください。"
                .to_string()
        },
    })
}

/// セッション span の RAII ハンドル。Drop で span を閉じる。
///
/// Phase 1: 内部に Instant を持ち、duration を計算して stderr にログするだけ。
/// Phase 2 で `tracing::Span` / `opentelemetry::Span` に差し替える。
pub struct SessionSpan {
    pub session_id: String,
    pub provider: &'static str,
    started_at: Instant,
    finished: bool,
}

impl SessionSpan {
    pub fn finish_ok(mut self) {
        self.finish_inner(true);
    }

    pub fn finish_err(mut self, _msg: &str) {
        self.finish_inner(false);
    }

    fn finish_inner(&mut self, ok: bool) {
        if self.finished {
            return;
        }
        self.finished = true;
        if !is_active() {
            return;
        }
        let dur = self.started_at.elapsed();
        eprintln!(
            "[unicrew/otel] session.end provider={} session_id={} duration_ms={} ok={}",
            self.provider,
            self.session_id,
            dur.as_millis(),
            ok
        );
    }
}

impl Drop for SessionSpan {
    fn drop(&mut self) {
        if !self.finished {
            self.finish_inner(true);
        }
    }
}

/// agent_start 直前で呼ぶ。span を返すので呼び側で保持する。
pub fn start_session_span(
    session_id: impl Into<String>,
    provider: &'static str,
) -> SessionSpan {
    let s = SessionSpan {
        session_id: session_id.into(),
        provider,
        started_at: Instant::now(),
        finished: false,
    };
    if is_active() {
        eprintln!(
            "[unicrew/otel] session.start provider={} session_id={}",
            s.provider, s.session_id
        );
    }
    s
}
