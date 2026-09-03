#!/usr/bin/env python
"""版数が1か所にそろっているかを、出荷前に機械で確かめる。

# なぜこのスクリプトが要るか

版数は5か所に散っている（package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json /
lib/whatsnew.ts の fallback / public/whatsnew/<version>.md）。2026-09-03 の実測では
package.json と Cargo.toml が 0.3.7 なのに whatsnew は 0.3.2 で止まっており、
**5版ぶん（0.3.3〜0.3.7）の告知が利用者に一度も出ていなかった**。
「リリース手順：版数3ファイル更新」は人が守る手順で、守られなかった。だから機械で止める。

# 見るもの（数えられる事実だけ）

| # | 何を | 合格 |
|---|---|---|
| 1 | package.json / Cargo.toml / tauri.conf.json の version | 3つが同じ |
| 2 | Cargo.lock の `name = "unicrew"` の version | package.json と同じ（cargo check で更新される） |
| 3 | lib/whatsnew.ts の fallback 定数 | package.json と同じ（本番は NEXT_PUBLIC_UNICREW_VERSION が勝つが、fallback が古いと非Tauri表示で嘘をつく） |
| 4 | public/whatsnew/<version>.md | 存在し、200バイト以上（空の告知を出荷しない） |
| 5 | components/SettingsModal.tsx | `currentVersion="0.x.y"` のベタ書きが無い |
| 6 | package-lock.json の先頭の version | package.json と同じ（`npm install` で同期される。2026-09-04 実測＝0.2.36 のまま止まっていた） |

ERROR が 1 つでもあれば終了コード 1（タグを打たない）。

# 毒味

`--selftest` は、わざとずらした一式（Cargo.toml だけ古い／whatsnew が無い／fallback が古い）を
一時フォルダに作って食わせ、**落ちるべきときに落ちる**ことを確かめる。
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def version_of_package(root: Path) -> str | None:
    p = root / "package.json"
    if not p.exists():
        return None
    return json.loads(read(p)).get("version")


def version_of_tauri_conf(root: Path) -> str | None:
    p = root / "src-tauri" / "tauri.conf.json"
    if not p.exists():
        return None
    return json.loads(read(p)).get("version")


def version_of_cargo_toml(root: Path) -> str | None:
    p = root / "src-tauri" / "Cargo.toml"
    if not p.exists():
        return None
    m = re.search(r'^version\s*=\s*"([^"]+)"', read(p), re.M)
    return m.group(1) if m else None


def version_of_cargo_lock(root: Path) -> str | None:
    p = root / "src-tauri" / "Cargo.lock"
    if not p.exists():
        return None
    m = re.search(r'\[\[package\]\]\s*\nname = "unicrew"\s*\nversion = "([^"]+)"', read(p))
    return m.group(1) if m else None


def version_of_whatsnew_fallback(root: Path) -> str | None:
    p = root / "lib" / "whatsnew.ts"
    if not p.exists():
        return None
    m = re.search(r'UNICREW_VERSION_FALLBACK\s*=\s*"([^"]+)"', read(p))
    return m.group(1) if m else None


def version_of_package_lock(root: Path) -> str | None:
    p = root / "package-lock.json"
    if not p.exists():
        return None
    return json.loads(read(p)).get("version")


def hardcoded_current_version(root: Path) -> str | None:
    p = root / "components" / "SettingsModal.tsx"
    if not p.exists():
        return None
    m = re.search(r'currentVersion="(\d+\.\d+\.\d+)"', read(p))
    return m.group(1) if m else None


def check(root: Path) -> list[str]:
    errors: list[str] = []
    pkg = version_of_package(root)
    if not pkg:
        return ["package.json の version が読めません"]
    pairs = {
        "src-tauri/Cargo.toml": version_of_cargo_toml(root),
        "src-tauri/tauri.conf.json": version_of_tauri_conf(root),
        "src-tauri/Cargo.lock (unicrew)": version_of_cargo_lock(root),
        "lib/whatsnew.ts UNICREW_VERSION_FALLBACK": version_of_whatsnew_fallback(root),
        "package-lock.json": version_of_package_lock(root),
    }
    for name, v in pairs.items():
        if v is None:
            errors.append(f"{name}: version が見つかりません")
        elif v != pkg:
            errors.append(f"{name}: {v} ≠ package.json {pkg}")
    wn = root / "public" / "whatsnew" / f"{pkg}.md"
    if not wn.exists():
        errors.append(f"public/whatsnew/{pkg}.md がありません（この版の告知が出ない）")
    elif wn.stat().st_size < 200:
        errors.append(f"public/whatsnew/{pkg}.md が {wn.stat().st_size} バイトしかありません（空の告知）")
    hc = hardcoded_current_version(root)
    if hc:
        errors.append(f"components/SettingsModal.tsx に currentVersion=\"{hc}\" のベタ書きがあります（UNICREW_VERSION を使う）")
    return errors


def report(root: Path) -> int:
    errors = check(root)
    pkg = version_of_package(root)
    print(f"version: {pkg}")
    for e in errors:
        print(f"ERROR: {e}")
    print(f"ERROR {len(errors)}")
    return 1 if errors else 0


def make_fixture(dst: Path, *, version: str, cargo: str | None = None, lock: str | None = None,
                 conf: str | None = None, fallback: str | None = None, whatsnew: bool = True,
                 hardcode: bool = False, pkglock: str | None = None) -> None:
    (dst / "src-tauri").mkdir(parents=True)
    (dst / "lib").mkdir()
    (dst / "components").mkdir()
    (dst / "public" / "whatsnew").mkdir(parents=True)
    (dst / "package.json").write_text(json.dumps({"name": "unicrew", "version": version}), encoding="utf-8")
    (dst / "package-lock.json").write_text(json.dumps({"name": "unicrew", "version": pkglock or version, "lockfileVersion": 3}), encoding="utf-8")
    (dst / "src-tauri" / "Cargo.toml").write_text(f'[package]\nname = "unicrew"\nversion = "{cargo or version}"\n', encoding="utf-8")
    (dst / "src-tauri" / "Cargo.lock").write_text(
        f'[[package]]\nname = "tokio"\nversion = "1.40.0"\n\n[[package]]\nname = "unicrew"\nversion = "{lock or version}"\n',
        encoding="utf-8",
    )
    (dst / "src-tauri" / "tauri.conf.json").write_text(json.dumps({"version": conf or version}), encoding="utf-8")
    (dst / "lib" / "whatsnew.ts").write_text(f'const UNICREW_VERSION_FALLBACK = "{fallback or version}";\n', encoding="utf-8")
    body = "# x\n" + ("- 変更\n" * 60) if whatsnew else ""
    if whatsnew:
        (dst / "public" / "whatsnew" / f"{version}.md").write_text(body, encoding="utf-8")
    sm = '<UnicrewSelfUpdateSection currentVersion="0.2.1" />' if hardcode else "<UnicrewSelfUpdateSection currentVersion={UNICREW_VERSION} />"
    (dst / "components" / "SettingsModal.tsx").write_text(sm, encoding="utf-8")


def selftest() -> int:
    cases = [
        ("そろっている", dict(version="0.4.0"), 0),
        ("Cargo.toml だけ古い", dict(version="0.4.0", cargo="0.3.7"), 1),
        ("Cargo.lock が更新されていない", dict(version="0.4.0", lock="0.3.7"), 1),
        ("tauri.conf.json だけ古い", dict(version="0.4.0", conf="0.3.7"), 1),
        ("whatsnew の fallback が古い（2026-09-03 に実際に起きた形）", dict(version="0.4.0", fallback="0.3.2"), 1),
        ("この版の whatsnew が無い", dict(version="0.4.0", whatsnew=False), 1),
        ("SettingsModal にベタ書き", dict(version="0.4.0", hardcode=True), 1),
        ("package-lock.json が古い（2026-09-04 実測の形）", dict(version="0.4.0", pkglock="0.2.36"), 1),
    ]
    failed = 0
    for name, kw, expect in cases:
        tmp = Path(tempfile.mkdtemp(prefix="uc_vsync_"))
        try:
            make_fixture(tmp, **kw)
            n = len(check(tmp))
            ok = (n == 0) if expect == 0 else (n >= 1)
            print(f"{'OK ' if ok else 'NG '} {name}: ERROR {n}")
            if not ok:
                failed += 1
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    print(f"selftest: {len(cases) - failed}/{len(cases)} OK")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--selftest", action="store_true", help="わざとずらした一式で、落ちるべきときに落ちるかを確かめる")
    ap.add_argument("--root", default=str(ROOT), help="検査するリポジトリ（既定: このスクリプトの親の親）")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    return report(Path(args.root))


if __name__ == "__main__":
    sys.exit(main())
