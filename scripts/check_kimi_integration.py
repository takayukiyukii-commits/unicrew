"""Sprint 3 Kimi 統合の UI 表示検証。

確認:
1. WelcomeLanding の「プリセットから議論を始める」で「東西 ACP 議論」が見える
2. 設定モーダルの OSS 系 accordion が「0/7 接続」（goose/opencode/ollama/codex-acp/kiro/qwen/kimi）
3. Kimi Code CLI 行が表示されている
4. コンソールエラー 0
"""
from playwright.sync_api import sync_playwright
from pathlib import Path

SHOT_DIR = Path(r"D:\company\CDO（技術責任者）\_screenshots\20260511_unicrew_kimi")
SHOT_DIR.mkdir(parents=True, exist_ok=True)

errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type in ("error",) else None)
    page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))

    page.goto("http://localhost:1420")
    page.wait_for_load_state("networkidle")

    # プリセット
    page.locator("summary").filter(has_text="プリセットから議論を始める").first.click()
    page.wait_for_timeout(300)
    east_west = page.locator("text=東西 ACP 議論").count()
    print(f"東西 ACP 議論プリセット: {east_west}")
    page.screenshot(path=str(SHOT_DIR / "01_presets.png"), full_page=True)

    # 設定モーダル
    page.get_by_role("button", name="設定").first.click()
    page.wait_for_timeout(500)
    page.locator("summary").filter(has_text="ローカル / OSS 系").first.click()
    page.wait_for_timeout(400)
    page.screenshot(path=str(SHOT_DIR / "02_settings_oss.png"), full_page=True)

    kimi_label = page.locator("text=Kimi Code CLI").count()
    seven = page.locator("text=0 / 7 接続").count()
    print(f"Kimi Code CLI 行: {kimi_label}")
    print(f"'0 / 7 接続' バッジ: {seven}")

    browser.close()

print("---errors---")
for e in errors:
    print(e)
print(f"total errors: {len(errors)}")
print(f"screenshots: {SHOT_DIR}")
