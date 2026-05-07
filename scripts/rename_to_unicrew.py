"""
UNIPILOT → UNICREW 一括リネーム。

注意:
- フォルダ名（`repos/unipilot/`）は触らない。リポ内の文字列のみ書換。
- パス文字列に含まれる "unipilot" は対象外（誤書換防止）。
- 大文字小文字区別あり: UNIPILOT→UNICREW / UniPilot→UniCrew / unipilot→unicrew (但しパス除外)。
"""
from pathlib import Path
import re
import sys

REPO = Path(__file__).resolve().parent.parent

TARGETS = [
    "app/globals.css",
    "app/page.tsx",
    "components/AddonsSection.tsx",
    "components/ChatPane.tsx",
    "components/MessageItem.tsx",
    "components/SettingsModal.tsx",
    "components/Sidebar.tsx",
    "components/WelcomeLanding.tsx",
    "lib/addons.ts",
    "lib/characters.ts",
    "lib/personalities.ts",
    "lib/storage.ts",
    "lib/tauri.ts",
    "next.config.ts",
    "public/brand/preview.html",
    "README.md",
    "sidecar/agent.mjs",
    "sidecar/codex-agent.mjs",
]

# 順番が重要: 大文字 → 小文字。先に "unipilot" を変えると "UNIPILOT" まで巻き込む可能性がある。
# 各置換は独立。
PATTERNS = [
    (re.compile(r"UNIPILOT"), "UNICREW"),
    (re.compile(r"UniPilot"), "UniCrew"),
    # パス文字列に含まれる "unipilot" は除外。
    # OneDrive のパス、`repos/unipilot/`、`/unipilot/` などはマッチさせない。
    (re.compile(r"(?<![/\\.\w])unipilot(?![/\\\w])"), "unicrew"),
]


def transform(text: str) -> tuple[str, int]:
    n = 0
    out = text
    for pat, repl in PATTERNS:
        out, count = pat.subn(repl, out)
        n += count
    return out, n


def main() -> int:
    total = 0
    for rel in TARGETS:
        p = REPO / rel
        if not p.exists():
            print(f"  [skip] {rel}: not found")
            continue
        original = p.read_text(encoding="utf-8")
        new_text, count = transform(original)
        if count == 0:
            print(f"  [no-op] {rel}")
            continue
        p.write_text(new_text, encoding="utf-8")
        total += count
        print(f"  [{count} sub] {rel}")
    print(f"\nTotal substitutions: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
