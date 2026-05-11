"""Verify FreeModeWizard renders on click of '1分で始める'."""
from playwright.sync_api import sync_playwright
from pathlib import Path

SHOT_DIR = Path(r"D:\company\CDO（技術責任者）\_screenshots\20260511_unicrew_freemode")
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

    page.screenshot(path=str(SHOT_DIR / "01_welcome.png"), full_page=True)

    # 「1分で始める」ボタンをクリック
    btn = page.get_by_role("button", name="1分で始める")
    assert btn.count() > 0, "「1分で始める」ボタンが見つからない"
    btn.first.click()
    page.wait_for_timeout(500)

    # モーダルのタイトル文言で検証
    assert page.locator("text=完全自動セットアップ").count() > 0, "FreeModeWizardのヘッダーが見えない"
    page.screenshot(path=str(SHOT_DIR / "02_wizard_open.png"), full_page=True)

    # ステップ行が4つあるか
    step_count = page.locator("li").filter(has_text="準備").count() + page.locator("li").filter(has_text="ダウンロード").count() + page.locator("li").filter(has_text="最初の会話").count()
    print(f"step rows visible: {step_count}")

    # 詳細ログ折りたたみ
    log_summary = page.locator("text=詳細ログ").first
    if log_summary.count() > 0:
        log_summary.click()
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOT_DIR / "03_wizard_log_open.png"), full_page=True)

    # 閉じる
    page.get_by_role("button", name="中断して閉じる").click()
    page.wait_for_timeout(300)
    page.screenshot(path=str(SHOT_DIR / "04_after_close.png"), full_page=True)

    browser.close()

print("---console errors---")
for e in errors:
    print(e)
print(f"total errors: {len(errors)}")
print(f"screenshots: {SHOT_DIR}")
