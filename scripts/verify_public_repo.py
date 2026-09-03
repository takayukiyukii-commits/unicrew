# -*- coding: utf-8 -*-
"""観点13（属人性・配布境界）の機械検査。

公開リポジトリ `takayukiyukii-commits/unicrew` に、社内の絶対パス・個人名・連絡先・
社内限定の符丁・鍵らしきものが混ざっていないかを数える。過去に同型の事故がある
（2026-08 に「公開リポジトリから社内の絶対パスを外す」「HONJIN.md / GEMINI.md を含めない」）。

見るのは **git が追跡しているファイルだけ**（＝実際に配られるもの）。
毒味: --selftest でわざと汚したファイルを食わせ、落ちるべきときに落ちるか確かめる。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# (名前, 正規表現, 説明) — 日本語の窓に限らず、配布物に出てはいけないものだけ
RULES = [
    ("社内の絶対パス(D:)", re.compile(r"[Dd]:[\\/]+(?:company|Downloads|Programs|demoshot)"), "社内PCの置き場が露出する"),
    ("社内の絶対パス(C:Users)", re.compile(r"[Cc]:[\\/]+Users[\\/]+(?!foo|bar|baz|user|users|x|y|z|test|alice|bob|name|username|<|%|\$|\.)[A-Za-z0-9_.-]+"), "利用者名が露出する"),
    ("Windows ユーザー名", re.compile(r"\btakay\b"), "個人の Windows ユーザー名"),
    ("個人メール", re.compile(r"[A-Za-z0-9._%+-]+@(?:gmail|yahoo|outlook|icloud)\.[A-Za-z]{2,}"), "個人の連絡先"),
    ("社内フォルダ名", re.compile(r"company[\\/]+(?:CDO|CMO|CSO|CPO|CFO)|(?:CDO|CMO|CSO|CPO|CFO)（(?:技術|マーケティング|営業|プロダクト|財務)責任者）[\\/]"), "社内の組織フォルダ"),
    ("社内の符丁", re.compile(r"(?:HONJIN\.md|HONJIN:vault-rule|一次情報倉庫|原液|結城さん)"), "社内限定の呼び方・個人名"),
    ("社内サーバの内部パス", re.compile(r"mcp\.uni-core\.jp/mcp|ZBL-[A-Za-z0-9]{6,}"), "会員向けの鍵・内部経路"),
    ("秘密らしき値", re.compile(r"(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})"), "APIキー・トークン"),
]

# 誤検出を避ける除外（正当な用途）
ALLOW = [
    # .gitignore の除外規則そのもの（配らないための行）は正当
    re.compile(r"^\s*!?HONJIN\.md\s*$"),
    # 公開ドメインとしての uni-core.jp（LP・ヘルプへのリンク）は正当
    re.compile(r"https://(?:hub|desk|post|step|reach|unilinks|echo)\.uni-core\.jp"),
]

SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".webp", ".woff", ".woff2", ".ttf",
            ".mp4", ".mp3", ".zip", ".exe", ".dll", ".pdb", ".lock"}


def tracked_files(root: Path) -> list[str]:
    r = subprocess.run(["git", "-C", str(root), "ls-files"], capture_output=True, text=True, encoding="utf-8")
    return [x for x in r.stdout.splitlines() if x.strip()]


# この検査そのもの。規則と毒味データが「探している形」を必ず含むので、自分は走査しない。
# 🚨 2026-09-04 実測：コミットして追跡対象になった瞬間に自分を12件撃ち、CI が必ず落ちる形になっていた
#    （working tree では未追跡だったので ERROR 0 に見えていた）。**検査は本番の形で1回回す。**
#    ここに秘密を隠せてしまう穴と引き換えなので、このファイルには実在の値を書かない
#    （毒味の値は `foo` `someone@` `sk-abcdef…` のように、見て偽物と分かるものだけにする）。
SELF = Path(__file__).resolve()


def scan(root: Path, files: list[str]) -> list[tuple[str, int, str, str]]:
    hits: list[tuple[str, int, str, str]] = []
    for rel in files:
        p = root / rel
        if p.suffix.lower() in SKIP_EXT or not p.exists():
            continue
        try:
            if p.resolve() == SELF:
                continue
        except OSError:
            pass
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            # ALLOW は「行ごと飛ばす」のではなく「許可した部分だけを伏せる」。
            # 行ごと飛ばすと、許可URLと社内の絶対パスが同じ行に並んだときに本物を見逃す
            # （2026-09-04 ダブル監査・2周目で指摘された）。
            masked = line
            for a in ALLOW:
                masked = a.sub(lambda m: "�" * len(m.group(0)), masked)
            for name, rx, _why in RULES:
                if rx.search(masked):
                    hits.append((rel, i, name, line.strip()[:140]))
    return hits


def _safe(x: str) -> str:
    return x.encode(sys.stdout.encoding or "utf-8", "replace").decode(sys.stdout.encoding or "utf-8", "replace")


def report(root: Path) -> int:
    files = tracked_files(root)
    hits = scan(root, files)
    print(f"追跡ファイル {len(files)} 件を検査")
    for rel, i, name, line in hits:
        print(_safe(f"ERROR: {rel}:{i} [{name}] {line}"))
    print(f"ERROR {len(hits)}")
    return 1 if hits else 0


def selftest() -> int:
    cases = [
        ("きれい", "const x = 1;\n// 公開して問題ない行\n", 0),
        ("社内の絶対パス", 'const p = "D:\\\\company\\\\CDO";\n', 1),
        ("Cドライブのユーザー名", 'const p = "C:/Users/takay/AppData";\n', 1),
        ("社内フォルダ名", "// 出典: company/CDO（技術責任者）/成果物/x.js\n", 1),
        ("社内の符丁", "// このフォルダの HONJIN.md を読む\n", 1),
        ("個人メール", "// contact: someone@gmail.com\n", 1),
        ("APIキーらしき値", 'const k = "sk-abcdefghijklmnopqrstuvwxyz012345";\n', 1),
        ("公開ドメインは通す", "// https://hub.uni-core.jp/app へ\n", 0),
        ("許可URLと社内パスが同じ行なら落ちる", "// https://hub.uni-core.jp/app / local: D:/company/CDO\n", 1),
        ("製品名 HONJIN は通す", "| **HONJIN** | 商いの今日 | Releases |\n", 0),
        ("テストの架空パスは通す", 'expect(p("C:/Users/foo/x.md")).toBe(0);\n', 0),
        ("キャラのテンプレ名は通す", "| tmpl-cdo | CDO | 技術責任者 | claude |\n", 0),
    ]
    failed = 0
    for name, body, expect in cases:
        d = Path(tempfile.mkdtemp(prefix="uc_dist_"))
        try:
            subprocess.run(["git", "-C", str(d), "init", "-q"], capture_output=True)
            (d / "a.ts").write_text(body, encoding="utf-8")
            subprocess.run(["git", "-C", str(d), "add", "-A"], capture_output=True)
            n = len(scan(d, ["a.ts"]))
            ok = (n == 0) if expect == 0 else (n >= 1)
            print(f"{'OK ' if ok else 'NG '} {name}: ERROR {n}")
            if not ok:
                failed += 1
        finally:
            import shutil

            shutil.rmtree(d, ignore_errors=True)
    print(f"selftest: {len(cases) - failed}/{len(cases)} OK")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--root", default=str(REPO))
    a = ap.parse_args()
    return selftest() if a.selftest else report(Path(a.root))


if __name__ == "__main__":
    sys.exit(main())
