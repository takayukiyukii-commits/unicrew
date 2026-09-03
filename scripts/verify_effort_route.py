#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ターミナルの「エフォート（思考の深さ）」指定が、実物の CLI と合っているかを測る。

なぜ要るか:
  自社コードを 1 文字も変えていなくても、相手の CLI がフラグを整理した瞬間に壊れる。
  verify_codex_route.py と同じ思想で、**実物を叩いて**カタログと突き合わせる。

判定は 3 値で返す:
  OK        … 実物とカタログが一致した
  NG        … 食い違った（直す必要がある）
  判定不能  … 測れなかった（未インストール等）。**PASS と書かない**

使い方:
  python scripts/verify_effort_route.py
  python scripts/verify_effort_route.py --selftest   # 毒味（わざと壊して落ちるか見る）
  python scripts/verify_effort_route.py --deep       # claude の値を1つずつ実際に投げる（API 課金あり）

終了コード: NG が 1 つでもあれば 1、無ければ 0（判定不能は 0 のまま＝嘘の合格にしない）
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "lib" / "terminal-effort.ts"

OK = "OK"
NG = "NG"
UNKNOWN = "判定不能"


def run(cmd: list[str], timeout: int = 90) -> tuple[int, str]:
    """
    コマンドを実行して (returncode, stdout+stderr) を返す。失敗は例外にしない。

    🚨 Windows の npm 製 CLI は `codex.CMD` のようなバッチのシムで、
    素の名前（"codex"）では起動できず FileNotFoundError になる。
    which() で実体の絶対パスへ解決してから渡す。
    （2026-09-04 実測: これが無いと codex と grok が「判定不能」になり、
      手では叩けているのに検査だけ測れないという状態になった）
    """
    exe = shutil.which(cmd[0]) or cmd[0]
    try:
        p = subprocess.run(
            [exe, *cmd[1:]],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=False,
        )
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except FileNotFoundError:
        return 127, "not found"
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    except OSError as e:  # Windows の .cmd シム等
        return 126, str(e)


def which(name: str) -> str | None:
    """PATH 上の実体（Windows の .cmd シムも拾う）。"""
    return shutil.which(name)


def parse_catalog(text: str | None = None) -> dict[str, list[str]]:
    """
    lib/terminal-effort.ts から「CLI id → levels」を読む。
    正本はコードの側なので、ここでは値を持たない（2 か所に書かない）。
    """
    src = text if text is not None else CATALOG.read_text(encoding="utf-8")
    body = src.split("EFFORT_SUPPORT", 1)[-1]
    out: dict[str, list[str]] = {}
    # 例:  claude: {  ... levels: ["low", "medium"], ...
    for m in re.finditer(r"(\w+):\s*\{(.*?)\n  \},", body, re.S):
        cli = m.group(1)
        block = m.group(2)
        lv = re.search(r"levels:\s*\[(.*?)\]", block, re.S)
        if not lv:
            continue
        levels = re.findall(r'"([^"]+)"', lv.group(1))
        out[cli] = levels
    return out


def check_claude(catalog: dict[str, list[str]], deep: bool) -> list[tuple[str, str, str]]:
    rows: list[tuple[str, str, str]] = []
    if not which("claude"):
        rows.append(("claude: --effort フラグの存在", UNKNOWN, "claude が PATH にない"))
        return rows
    code, out = run(["claude", "--help"])
    has_flag = "--effort" in out
    rows.append(
        (
            "claude: --effort フラグの存在",
            OK if has_flag else NG,
            "見つかった" if has_flag else "--help に --effort が無い（仕様変更）",
        )
    )
    # 🚨 claude の --help は取れる値を列挙しない。
    #    値の一致は「実際に投げてみる」以外に手が無いので、既定では 判定不能 を返す。
    if not deep:
        rows.append(
            (
                "claude: 値の一覧の一致",
                UNKNOWN,
                "--help が値を列挙しない。--deep で1値ずつ実投げ（API 課金あり）",
            )
        )
        return rows
    for level in catalog.get("claude", []):
        code, out = run(["claude", "--effort", level, "-p", "ok"], timeout=180)
        warned = "Unknown --effort value" in out
        rows.append(
            (
                f"claude: 値 {level} が受理されるか",
                NG if warned else OK,
                "警告が出た（＝無視されて既定で動く）" if warned else "警告なし",
            )
        )
    return rows


def check_codex(catalog: dict[str, list[str]]) -> list[tuple[str, str, str]]:
    if not which("codex"):
        return [("codex: 値の一覧の一致", UNKNOWN, "codex が PATH にない")]
    code, out = run(["codex", "debug", "models"], timeout=180)
    start = out.find("{")
    if code != 0 or start < 0:
        return [("codex: 値の一覧の一致", UNKNOWN, "codex debug models が読めない")]
    try:
        data = json.loads(out[start:])
    except json.JSONDecodeError:
        return [("codex: 値の一覧の一致", UNKNOWN, "JSON として読めない")]
    sets = []
    for m in data.get("models", []):
        levels = {x.get("effort") for x in m.get("supported_reasoning_levels", [])}
        if levels:
            sets.append(levels)
    if not sets:
        return [("codex: 値の一覧の一致", UNKNOWN, "モデル情報が空")]
    common = sorted(set.intersection(*sets))
    ours = sorted(catalog.get("codex", []))
    # 🚨 カタログは「全モデル共通の値」だけを載せる約束。
    #    共通集合と一致しなければ、載せている値がどこかのモデルで 400 になる。
    ok = ours == common
    return [
        (
            "codex: 値の一覧の一致（全モデル共通）",
            OK if ok else NG,
            f"実物={common} / カタログ={ours}（モデル {len(sets)} 件）",
        )
    ]


def check_grok(catalog: dict[str, list[str]]) -> list[tuple[str, str, str]]:
    if not which("grok"):
        return [("grok: 値の一覧の一致", UNKNOWN, "grok が PATH にない")]
    # 不正値を渡すと、引数解析の時点でエラーになり、使える値を列挙してくれる
    # （API は叩かれない＝無料・速い）
    code, out = run(["grok", "--reasoning-effort", "__invalid__", "-p", "hi"], timeout=90)
    m = re.search(r"use one of:\s*([^\n\r]+)", out, re.I)
    if not m:
        return [
            (
                "grok: 値の一覧の一致",
                UNKNOWN,
                "不正値のエラー文から値を取れなかった（文言変更の可能性）",
            )
        ]
    real = sorted(x.strip() for x in re.split(r"[,\s]+", m.group(1)) if x.strip())
    ours = sorted(catalog.get("grok", []))
    ok = real == ours
    return [
        (
            "grok: 値の一覧の一致",
            OK if ok else NG,
            f"実物={real} / カタログ={ours}",
        )
    ]


def check_kimi(catalog: dict[str, list[str]]) -> list[tuple[str, str, str]]:
    if not which("kimi"):
        return [("kimi: --thinking の存在", UNKNOWN, "kimi が PATH にない")]
    code, out = run(["kimi", "--help"], timeout=90)
    has_on = "--thinking" in out
    has_off = "--no-thinking" in out
    ok = has_on and has_off and sorted(catalog.get("kimi", [])) == ["fast", "think"]
    return [
        (
            "kimi: --thinking / --no-thinking の存在",
            OK if ok else NG,
            f"--thinking={has_on} / --no-thinking={has_off}",
        )
    ]


def check_unsupported(catalog: dict[str, list[str]]) -> list[tuple[str, str, str]]:
    """
    「対応していない」と決めた CLI に、実はフラグが生えていないかを見る。
    生えていたら NG（＝機能を取りこぼしている）。
    """
    rows: list[tuple[str, str, str]] = []
    for cli in ["gemini", "qwen"]:
        if cli in catalog:
            rows.append((f"{cli}: 非対応の想定", NG, "カタログに載っている"))
            continue
        if not which(cli):
            rows.append((f"{cli}: 非対応の想定", UNKNOWN, f"{cli} が PATH にない"))
            continue
        code, out = run([cli, "--help"], timeout=90)
        found = re.search(r"--(reasoning-)?effort|--thinking", out)
        rows.append(
            (
                f"{cli}: 非対応の想定",
                NG if found else OK,
                "フラグが増えている（対応を足せる）" if found else "フラグ無し（想定どおり）",
            )
        )
    for cli in ["opencode", "goose", "cursor-agent"]:
        rows.append((f"{cli}: 未確認", UNKNOWN, "この PC では確認していない"))
    return rows


def selftest() -> int:
    """
    毒味: わざと壊したカタログを食わせて、落ちるべきときに落ちるかを 1 回実測する。
    ここが OK のままなら、この検査自体を信用してはいけない。
    """
    print("== 毒味（--selftest）==")
    fake = '''
export const EFFORT_SUPPORT = {
  codex: {
    mode: { kind: "config", key: "model_reasoning_effort" },
    levels: ["banana", "low"],
    silentOnInvalid: false,
    midSession: "restart",
  },
};
'''
    catalog = parse_catalog(fake)
    if catalog.get("codex") != ["banana", "low"]:
        print(f"  NG: 壊したカタログを読めていない（{catalog}）")
        return 1
    rows = check_codex(catalog)
    status = rows[0][1]
    if status == NG:
        print("  OK: 壊したカタログを NG として検出できた")
        return 0
    if status == UNKNOWN:
        print("  判定不能: codex が無いので毒味できなかった（この PC では未検証）")
        return 0
    print("  🚨 NG: 壊れているのに OK を返した＝この検査は信用できない")
    return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true", help="毒味だけ実行する")
    ap.add_argument(
        "--deep",
        action="store_true",
        help="claude の値を1つずつ実際に投げて確かめる（API 課金あり・遅い）",
    )
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    catalog = parse_catalog()
    if not catalog:
        print("NG: lib/terminal-effort.ts からカタログを読めなかった")
        return 1
    print(f"カタログ: {catalog}\n")

    rows: list[tuple[str, str, str]] = []
    rows += check_claude(catalog, args.deep)
    rows += check_codex(catalog)
    rows += check_grok(catalog)
    rows += check_kimi(catalog)
    rows += check_unsupported(catalog)

    width = max(len(r[0]) for r in rows) + 2
    ng = 0
    unknown = 0
    for name, status, note in rows:
        if status == NG:
            ng += 1
        if status == UNKNOWN:
            unknown += 1
        print(f"{name.ljust(width)} {status.ljust(8)} {note}")
    print(f"\nNG={ng} / 判定不能={unknown} / 合計={len(rows)}")
    if ng:
        print("🚨 カタログと実物が食い違っている。lib/terminal-effort.ts を直すこと。")
    return 1 if ng else 0


if __name__ == "__main__":
    sys.exit(main())
