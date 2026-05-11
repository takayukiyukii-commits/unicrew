"""会社ドキュメント・メモリ側の UNIPILOT → UNICREW 一括書換。

履歴的な作業レポート（YYYYMMDD_*_UNIPILOT_*.md）は **触らない**。
それらは過去時点の名称を記録した正本なので、後から書き換えると履歴が崩れる。
"""
from pathlib import Path
import re
import sys

TARGETS = [
    # 現在地ナレッジ（リブランド済の正本）
    Path(r"D:/company/ナレッジ/UNIシリーズ横断まとめ/24_UNICREW.md"),
    # メモリ
    Path(r"C:/Users/takay/.claude/projects/C--Users-takay-OneDrive--------company/memory/project_unipilot.md"),
    Path(r"C:/Users/takay/.claude/projects/C--Users-takay-OneDrive--------company/memory/project_unipilot_free_funnel.md"),
]

PATTERNS = [
    (re.compile(r"UNIPILOT"), "UNICREW"),
    (re.compile(r"UniPilot"), "UniCrew"),
    # path-segment は対象外。bare な "unipilot" 単語のみ。
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
    for p in TARGETS:
        if not p.exists():
            print(f"  [skip] {p}: not found")
            continue
        original = p.read_text(encoding="utf-8")
        new_text, count = transform(original)
        if count == 0:
            print(f"  [no-op] {p.name}")
            continue
        p.write_text(new_text, encoding="utf-8")
        total += count
        print(f"  [{count} sub] {p.name}")
    print(f"\nTotal substitutions: {total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
