"""Sprint 3 Qwen 統合の UI 表示検証。

確認:
1. WelcomeLanding の「プリセットから議論を始める」<details> を開いて
   「4極議論（西側3社 × Qwen）」と「完全無料議論」が見えるか
2. 設定モーダルを開いて「ローカル / OSS 系」accordion に Qwen Code 行があるか
3. コンソールエラー 0
"""
from playwright.sync_api import sync_playwright
from pathlib import Path

SHOT_DIR = Path(r"D:\company\CDO（技術責任者）\_screenshots\20260511_unicrew_qwen")
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

    # 「プリセットから議論を始める」<details> 展開
    preset_summary = page.locator("summary").filter(has_text="プリセットから議論を始める").first
    if preset_summary.count() > 0:
        preset_summary.click()
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOT_DIR / "02_presets_open.png"), full_page=True)

    # 4極議論プリセットの存在
    four_pole = page.locator("text=4極議論").count()
    fully_free = page.locator("text=完全無料議論").count()
    print(f"4極議論ボタン件数: {four_pole}")
    print(f"完全無料議論ボタン件数: {fully_free}")

    # 設定モーダル
    settings_btn = page.get_by_role("button", name="設定").first
    settings_btn.click()
    page.wait_for_timeout(500)
    page.screenshot(path=str(SHOT_DIR / "03_settings.png"), full_page=True)

    # ローカル / OSS 系 accordion を開く
    oss_summary = page.locator("summary").filter(has_text="ローカル / OSS 系").first
    if oss_summary.count() > 0:
        oss_summary.click()
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOT_DIR / "04_oss_accordion.png"), full_page=True)

    qwen_row = page.locator("text=Qwen Code").count()
    print(f"Qwen Code 行: {qwen_row}")

    # Qwen の説明文断片確認
    dashscope = page.locator("text=DASHSCOPE_API_KEY").count()
    print(f"DASHSCOPE_API_KEY 説明: {dashscope}")

    browser.close()

print("---console errors---")
for e in errors:
    print(e)
print(f"total errors: {len(errors)}")
print(f"screenshots: {SHOT_DIR}")
