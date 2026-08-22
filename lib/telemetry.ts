"use client";

/**
 * 匿名の起動記録（インストール数を数えるためだけのもの）。
 *
 * なぜ入れたか（2026-08-23）:
 *   これまで分かるのは「GitHubで何回ダウンロードされたか」だけで、
 *   そのうち何台が実際にインストールして起動したのかを知る手段が無かった。
 *   ダウンロード時にブラウザとWindowsが出す警告で止まっている人がどれだけいるかを
 *   測るには、DL数と起動数の差が要る。
 *
 * 🚨 送るのは3つだけ。ここに項目を足さないこと。
 *     install_id … 初回起動時に作る乱数UUID。個人にも端末名にも結びつかない
 *     version    … アプリのバージョン
 *     os         … 'win' / 'mac' / 'linux'
 *   会話内容・キャラクター設定・APIキー・ファイルパス・ユーザー名は対象外。
 *
 * 🚨 PRIVACY.md と必ず一致させること。実装だけ変えて文書を放置しない。
 * 🚨 設定でオフにしたら本当に送らない（ここで早期returnする）。
 * 🚨 ブラウザ（npm run dev）では送らない。開発中の起動を実数に混ぜない。
 */

import { isTauri } from "./tauri";
import { getAppVersion } from "./app-version";

const ENDPOINT = "https://hub.uni-core.jp/api/unicrew/ping";
const INSTALL_ID_KEY = "unicrew.installId";
export const USAGE_PING_KEY = "unicrew.sendAnonymousUsage";

/** 端末ごとの乱数ID。初回だけ作って保存する（個人情報は含まない） */
function getInstallId(): string | null {
  try {
    let id = localStorage.getItem(INSTALL_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(INSTALL_ID_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/** 既定はオン。明示的に "0" が入っているときだけオフ */
export function isUsagePingEnabled(): boolean {
  try {
    return localStorage.getItem(USAGE_PING_KEY) !== "0";
  } catch {
    return false;
  }
}

export function setUsagePingEnabled(on: boolean): void {
  try {
    localStorage.setItem(USAGE_PING_KEY, on ? "1" : "0");
  } catch {
    /* 保存できない環境では既定（オン）のまま */
  }
}

function detectOs(): "win" | "mac" | "linux" | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "win";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Linux|X11/i.test(ua)) return "linux";
  return null;
}

let sent = false;

/**
 * 起動時に一度だけ呼ぶ。失敗しても何も起きない（アプリの動作を計測で妨げない）。
 */
export async function sendLaunchPing(): Promise<void> {
  if (sent) return;
  sent = true;

  if (!isTauri()) return;          // 開発中のブラウザ起動は数えない
  if (!isUsagePingEnabled()) return; // オフなら本当に送らない

  const installId = getInstallId();
  if (!installId) return;

  try {
    const version = await getAppVersion();
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        install_id: installId,
        version: version || null,
        os: detectOs(),
      }),
      keepalive: true,
    });
  } catch {
    /* 通信できなくても無視する */
  }
}
