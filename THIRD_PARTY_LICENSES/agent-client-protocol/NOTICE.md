# agent-client-protocol

UNICREW は Zed Industries, Inc. が主導する業界標準オープンプロトコル
**Agent Client Protocol (ACP)** の Rust crate `agent-client-protocol` を
依存ライブラリとして取り込んでいます。

## 利用範囲

- src-tauri/src/providers/acp_transport.rs（共通 ACP レイヤー）
- src-tauri/src/providers/goose.rs（Goose プロバイダ実装で利用）
- 将来追加予定: opencode.rs / codex_acp.rs / kiro.rs（同 crate を共有）

## ライセンス

**Apache License, Version 2.0**

Copyright 2025 Zed Industries, Inc. and contributors.

ライセンス全文: <https://github.com/zed-industries/agent-client-protocol/blob/main/LICENSE>

Apache-2.0 §4(d) に基づき、配布物に本 NOTICE を同梱しています。

## upstream

- 公式仕様サイト: <https://agentclientprotocol.com>
- crates.io: <https://crates.io/crates/agent-client-protocol>
- GitHub: <https://github.com/zed-industries/agent-client-protocol>

## 商標

「Agent Client Protocol」「ACP」は Zed Industries, Inc. に帰属する場合があります。
UNICREW は Zed Industries, Inc. および同社の他プロダクト（Zed エディタ等）と
**一切無関係の独立したクライアントアプリ**です。
