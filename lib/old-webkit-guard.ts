// 古い macOS の WKWebView で UNICREW が「画面は出るのにボタンが一切効かない」状態になったとき、
// 黙って壊れたままにせず、何をすればよいかを画面に出す見張り（2026-10-13 macOS 12.7.6 で発生）。
//
// - CSS: Tailwind v4 の CSS は @layer の中にある。@layer 非対応（Safari 15.4 未満）では表示切替
//   （hidden 等）が全部無効になり、隠れているはずの画面が表に出て操作できない → すぐ案内を出す
// - JS: 画面のプログラムが動き出したら components/BootMarker.tsx が __UNICREW_BOOTED__ を立てる。
//   BOOT_TIMEOUT_MS たっても立たなければ「プログラムが動いていない」と判断して案内を出す
//
// 仕組み: 案内の中身は components/OldWebkitNotice.tsx が最初から HTML に書き出しておく（普段は非表示）。
// 見張りは <html> に data-unicrew-old-webkit="css|timeout" を付けるだけで、表示は OLD_WEBKIT_CSS が切り替える。
// 🚨 見張りが DOM 要素を差し込むと、React の hydration と食い違って案内ごと消される（2026-10-13 監査で実測）。
//    <html> の属性は React が書き換えないので、ここに印を付ける（app/layout.tsx の suppressHydrationWarning）。
//
// 🚨 OLD_WEBKIT_GUARD は <script> にそのまま埋め込まれ、変換されずに古い WebKit で実行される。
//    ES5 の書き方だけを使うこと（let/const・アロー関数・テンプレート文字列を使わない）。
//    tests/old-webkit-guard.test.tsx と scripts/verify_webkit_compat.mjs が検査している。
export const BOOT_TIMEOUT_MS = 20000;
export const OLD_WEBKIT_ATTR = "data-unicrew-old-webkit";
export const OLD_WEBKIT_NOTICE_ID = "unicrew-old-webkit";

export const OLD_WEBKIT_GUARD = `(function () {
  var root = document.documentElement;
  function show(reason) {
    if (root.getAttribute("${OLD_WEBKIT_ATTR}")) return;
    if (reason === "timeout" && window.__UNICREW_BOOTED__) return;
    root.setAttribute("${OLD_WEBKIT_ATTR}", reason);
  }
  // 案内が出ている間は、裏の画面にキー入力を渡さない（Shift+Tab で権限モードが切り替わる等の誤操作を防ぐ）
  function block(e) {
    if (!root.getAttribute("${OLD_WEBKIT_ATTR}")) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  window.addEventListener("keydown", block, true);
  window.addEventListener("keypress", block, true);
  window.addEventListener("keyup", block, true);
  if (typeof window.CSSLayerBlockRule === "undefined") show("css");
  setTimeout(function () { show("timeout"); }, ${BOOT_TIMEOUT_MS});
})();`;

// @layer の外に置く（古い WebKit でも効く）。案内の要素は普段 inline style で display:none。
export const OLD_WEBKIT_CSS = `html[${OLD_WEBKIT_ATTR}] #${OLD_WEBKIT_NOTICE_ID}{display:block !important}`;
