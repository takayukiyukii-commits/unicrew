"""WhatsNewModal の改行・余白を実画面で確認。"""
from playwright.sync_api import sync_playwright
from pathlib import Path

SHOT_DIR = Path(r"D:\company\CDO（技術責任者）\_screenshots\20260511_unicrew_whatsnew")
SHOT_DIR.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    page.add_init_script("""
      try {
        localStorage.setItem('unicrew.walkthroughDone', 'v1');
        localStorage.setItem('unicrew.lastSeenVersion', '0.1.0');
      } catch(e) {}
    """)
    page.goto("http://localhost:1420")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(1500)
    print("modal title visible:", page.locator("text=UNICREW 0.2.0").count())
    page.screenshot(path=str(SHOT_DIR / "01_whatsnew_top.png"), full_page=False)
    # Find the modal scroll container
    container = page.locator(".unicrew-md").first
    if container.count() > 0:
        # parent has overflow-y-auto
        container.evaluate("el => { let p = el.parentElement; while (p && getComputedStyle(p).overflowY !== 'auto' && getComputedStyle(p).overflowY !== 'scroll') p = p.parentElement; if (p) p.scrollTop = 500; }")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOT_DIR / "02_whatsnew_mid.png"), full_page=False)
        container.evaluate("el => { let p = el.parentElement; while (p && getComputedStyle(p).overflowY !== 'auto' && getComputedStyle(p).overflowY !== 'scroll') p = p.parentElement; if (p) p.scrollTop = 1200; }")
        page.wait_for_timeout(300)
        page.screenshot(path=str(SHOT_DIR / "03_whatsnew_bottom.png"), full_page=False)
    browser.close()
print(f"screenshots: {SHOT_DIR}")
