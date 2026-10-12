import { OLD_WEBKIT_CSS, OLD_WEBKIT_GUARD, OLD_WEBKIT_NOTICE_ID } from "@/lib/old-webkit-guard";

// 古い WebKit 向けの案内（理由と仕組みは lib/old-webkit-guard.ts）。
// Tailwind のクラスは使わない（@layer 非対応の環境で効かないため）。普段は非表示。
export function OldWebkitNotice() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: OLD_WEBKIT_GUARD }} />
      <style dangerouslySetInnerHTML={{ __html: OLD_WEBKIT_CSS }} />
      <div
        id={OLD_WEBKIT_NOTICE_ID}
        role="alert"
        style={{
          display: "none",
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 2147483647,
          background: "#faf9f6",
          color: "#1f2937",
          font: "15px/1.8 -apple-system, BlinkMacSystemFont, sans-serif",
          padding: 48,
          overflow: "auto",
        }}
      >
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 16px" }}>UNICREW をこの Mac で表示できません</h1>
          <p>Mac に入っている Safari が古いため、UNICREW の画面が動きません（Safari 15.4 以上が必要です）。</p>
          <p>
            <b>直し方：</b>画面左上のリンゴマーク →「システム設定」（古い Mac では「システム環境設定」）→「ソフトウェアアップデート」で、Safari または macOS を更新してから、UNICREW を開き直してください。
          </p>
          <p style={{ color: "#6b7280", fontSize: 13, marginTop: 24 }}>
            UNICREW can&apos;t run on this Mac because its Safari is too old (Safari 15.4 or later is required). Update
            Safari or macOS from Software Update, then reopen UNICREW.
          </p>
        </div>
      </div>
    </>
  );
}
