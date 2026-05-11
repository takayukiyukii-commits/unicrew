#!/usr/bin/env python
"""Bridge ファイル PUT 用の堅牢ヘルパ（Windows cp932 罠回避）。

Windows Git Bash で `bash変数 → curl -d` を経由するとUTF-8とcp932のダブル変換で
日本語が壊れる。Python で全部完結させてバイナリ送信する。

Usage:
  python scripts/bridge_put.py <key> <local_file>

例:
  python scripts/bridge_put.py handoff /path/to/handoff_new.md
"""
import json
import os
import sys
import urllib.request


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <key> <local_file>", file=sys.stderr)
        return 2
    key, src = sys.argv[1], sys.argv[2]

    base = os.environ.get("BRIDGE_BASE", "https://bridge.uni-core.jp").rstrip("/")
    token = os.environ.get("BRIDGE_API_TOKEN")
    if not token:
        print("BRIDGE_API_TOKEN 未設定", file=sys.stderr)
        return 3

    with open(src, "rb") as f:
        raw = f.read()
    text = raw.decode("utf-8")  # 入力ファイルは UTF-8 前提
    body = json.dumps({"content": text}, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        f"{base}/api/v1/files/{key}",
        data=body,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        print(r.read().decode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
