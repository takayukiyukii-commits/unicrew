"""UNICREW を GitHub に push する初期化スクリプト。

- API管理/APIキー一覧.md から GITHUB_TOKEN を読み出す（コマンドライン履歴に key を残さない）
- takayukiyukii-commits/unicrew （private）を作成し、初期コミットを push
- 何度実行しても安全（remote/repo の存在を見て差分のみ進める）

実行:
    python scripts/github_init_unicrew.py
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

REPO_DIR = Path(__file__).resolve().parent.parent
KEY_FILE = Path(
    r"D:/secrets/APIキー一覧.md"
)
OWNER = "takayukiyukii-commits"
REPO_NAME = "unicrew"


def load_token() -> str:
    if "GITHUB_TOKEN" in os.environ:
        return os.environ["GITHUB_TOKEN"]
    text = KEY_FILE.read_text(encoding="utf-8")
    m = re.search(r"`GITHUB_TOKEN`:\s*`(github_pat_[^`]+)`", text)
    if not m:
        raise SystemExit("GITHUB_TOKEN not found in API管理/APIキー一覧.md")
    return m.group(1)


def repo_exists(token: str) -> bool:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{OWNER}/{REPO_NAME}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "unicrew-init/1.0",
        },
    )
    try:
        urllib.request.urlopen(req).read()
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def create_repo(token: str) -> dict:
    body = json.dumps(
        {
            "name": REPO_NAME,
            "description": "UNICREW - あなた専属のAIチームを、5分で。Claude/Codex/スキル/MCPをターミナルなしで使えるAIデスクトップ",
            "private": True,
            "has_issues": True,
            "has_wiki": False,
            "auto_init": False,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        "https://api.github.com/user/repos",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "unicrew-init/1.0",
            "Content-Type": "application/json",
        },
    )
    try:
        return json.loads(urllib.request.urlopen(req).read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"create_repo failed: {e.code}\n{body_text}")


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    redacted = [
        re.sub(r"github_pat_[A-Za-z0-9_]+", "github_pat_***", c) for c in cmd
    ]
    print(f"  $ {' '.join(redacted)}", flush=True)
    return subprocess.run(cmd, cwd=REPO_DIR, capture_output=True, text=True)


def main() -> int:
    token = load_token()

    if repo_exists(token):
        print(f"[skip] {OWNER}/{REPO_NAME} already exists on GitHub")
    else:
        print(f"[create] {OWNER}/{REPO_NAME}")
        info = create_repo(token)
        print(f"  -> {info.get('html_url')}")

    if not (REPO_DIR / ".git").exists():
        r = run(["git", "init", "-b", "main"])
        if r.returncode != 0:
            raise SystemExit(r.stderr)

    cur_name = run(["git", "config", "user.name"])
    if cur_name.returncode != 0 or not cur_name.stdout.strip():
        run(["git", "config", "user.name", "takayuki yukii"])
    cur_email = run(["git", "config", "user.email"])
    if cur_email.returncode != 0 or not cur_email.stdout.strip():
        run(["git", "config", "user.email", "takayuki.yukii@gmail.com"])

    remote_url = f"https://{OWNER}:{token}@github.com/{OWNER}/{REPO_NAME}.git"
    rremote = run(["git", "remote", "get-url", "origin"])
    if rremote.returncode == 0:
        run(["git", "remote", "set-url", "origin", remote_url])
    else:
        run(["git", "remote", "add", "origin", remote_url])

    run(["git", "add", "-A"])
    rstatus = run(["git", "diff", "--cached", "--stat"])
    if not rstatus.stdout.strip():
        print("[skip] nothing to commit")
        return 0
    print("[stage]")
    print(rstatus.stdout[-2000:])
    rcommit = run([
        "git",
        "commit",
        "-m",
        (
            "Initial commit: UNICREW (旧UNIPILOT) AIデスクトップアプリ\n\n"
            "Tauri 2 + Next.js 16 + Claude Agent SDK + Codex SDK で構成。\n"
            "- Claude × Codex 並列・AI会議モード\n"
            "- カスタムキャラクター + 12種人格\n"
            "- 機能の追加（プラグイン/スキル/MCP 1クリック）\n"
            "- 音声入力（Whisper）\n"
            "- 初心者モード（CLI完全非表示）\n"
            "- UNI Series ハブ（Coming Soon）\n"
            "- 完全無料・UNIシリーズへのファネル製品\n\n"
            "タグライン: あなた専属のAIチームを、5分で。"
        ),
    ])
    if rcommit.returncode != 0:
        print("[commit failed]")
        print(rcommit.stderr[-1500:])
        return 1
    print("[commit done]\n" + rcommit.stdout[-400:])

    rpush = run(["git", "push", "-u", "origin", "main"])
    if rpush.returncode != 0:
        print("[push failed]")
        print(rpush.stderr[-1500:])
        return 1
    print("[push done]")
    print(f"\n✓ https://github.com/{OWNER}/{REPO_NAME}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
