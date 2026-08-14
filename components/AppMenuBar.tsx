"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  ExternalLink,
  HelpCircle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "@/lib/i18n";
import { useAppVersion } from "@/lib/app-version";

export interface MenuAction {
  label: string;
  onSelect: () => void;
  shortcut?: string;
  divider?: false;
}

export interface MenuDivider {
  divider: true;
}

export type MenuEntry = MenuAction | MenuDivider;

interface MenuDef {
  id: string;
  label: string;
  items: MenuEntry[];
}

interface Props {
  menus: MenuDef[];
  /**
   * アップデートチェック処理。未指定なら「現時点では最新版です」のダイアログを返す。
   * 真値（更新あり）/ 偽値（最新）を Promise で返すと、UI バッジが切り替わる。
   */
  onCheckUpdates?: () => Promise<{ hasUpdate: boolean; message?: string }>;
  /** 更新ありの状態でボタンを押したとき、適用 UI（設定モーダル）を開く。 */
  onOpenSettings?: () => void;
}

export function AppMenuBar({ menus, onCheckUpdates, onOpenSettings }: Props) {
  const { t } = useTranslation();
  const appVersion = useAppVersion();
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{
    hasUpdate: boolean;
    message?: string;
    checkedAt: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 外側クリックで閉じる
  useEffect(() => {
    if (!openMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openMenu]);

  // Esc で閉じる
  useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openMenu]);

  // 【2026-08-14】起動時に 1 回だけサイレント自動チェック。
  // 手動で押さない限り更新に気づけなかったため（設定モーダル内の手動確認のみ）、
  // 起動直後に裏でチェックして、更新があればボタンを緑バッジ化する。
  // silent=true では「最新版です」等のメッセージは出さない（起動時のノイズ防止）。
  const autoCheckedRef = useRef(false);
  useEffect(() => {
    if (!onCheckUpdates || autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await onCheckUpdates();
          if (result.hasUpdate) {
            setUpdateInfo({ ...result, checkedAt: Date.now() });
          }
        } catch {
          /* 起動時の失敗は黙って無視（手動チェックで表面化する） */
        }
      })();
    }, 3000); // 起動直後の初期化ラッシュを避けて 3 秒後
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCheck = async () => {
    // 更新ありバッジの状態でクリックされたら、再チェックではなく適用 UI を開く
    if (updateInfo?.hasUpdate && onOpenSettings) {
      onOpenSettings();
      return;
    }
    setChecking(true);
    try {
      if (onCheckUpdates) {
        const result = await onCheckUpdates();
        setUpdateInfo({ ...result, checkedAt: Date.now() });
      } else {
        setUpdateInfo({
          hasUpdate: false,
          message: t("appmenu.upToDate", { version: appVersion || "?" }),
          checkedAt: Date.now(),
        });
      }
    } catch (e) {
      setUpdateInfo({
        hasUpdate: false,
        message: e instanceof Error ? e.message : String(e),
        checkedAt: Date.now(),
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      ref={wrapRef}
      className="shrink-0 flex items-stretch border-b border-[var(--color-border)] bg-white text-[12.5px] select-none"
      style={{ height: 32 }}
    >
      <div className="px-3 flex items-center font-bold tracking-tight text-[13px] text-[var(--color-text)]">
        UNICREW
      </div>
      <div className="flex items-stretch">
        {menus.map((menu) => {
          const isOpen = openMenu === menu.id;
          return (
            <div key={menu.id} className="relative">
              <button
                type="button"
                onClick={() => setOpenMenu(isOpen ? null : menu.id)}
                onMouseEnter={() => {
                  if (openMenu) setOpenMenu(menu.id);
                }}
                className={clsx(
                  "h-full px-3 hover:bg-[var(--color-surface)] transition flex items-center gap-1",
                  isOpen && "bg-[var(--color-surface)]",
                )}
              >
                {menu.label}
                <ChevronDown size={11} className="opacity-60" />
              </button>
              {isOpen && (
                <div
                  className="absolute left-0 top-full min-w-[220px] rounded-md border border-[var(--color-border)] bg-white shadow-lg z-50 py-1"
                  role="menu"
                >
                  {menu.items.map((item, i) =>
                    "divider" in item ? (
                      <div
                        key={`d-${i}`}
                        className="my-1 border-t border-[var(--color-border)]"
                      />
                    ) : (
                      <button
                        key={`i-${i}`}
                        onClick={() => {
                          setOpenMenu(null);
                          item.onSelect();
                        }}
                        className="w-full px-3 py-1.5 flex items-center justify-between gap-3 text-left hover:bg-[var(--color-surface)]"
                        role="menuitem"
                      >
                        <span className="truncate">{item.label}</span>
                        {item.shortcut && (
                          <span className="font-mono text-[10.5px] text-[var(--color-muted)] shrink-0">
                            {item.shortcut}
                          </span>
                        )}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex-1" />
      <div className="flex items-center pr-2 gap-1">
        {updateInfo && updateInfo.message && (
          <span className="text-[11px] text-[var(--color-muted)] mr-1 truncate max-w-[260px]">
            {updateInfo.message}
          </span>
        )}
        <button
          type="button"
          onClick={handleCheck}
          disabled={checking}
          className={clsx(
            "h-7 px-2 rounded-md inline-flex items-center gap-1.5 text-[11.5px] transition border",
            updateInfo?.hasUpdate
              ? "bg-emerald-500 text-white border-emerald-500 hover:opacity-90"
              : "bg-white text-[var(--color-muted)] border-[var(--color-border)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]",
            checking && "opacity-60 cursor-wait",
          )}
          title={t("appmenu.checkUpdates")}
        >
          {checking ? (
            <>
              <Loader2 size={12} className="animate-spin" />
              {t("appmenu.checking")}
            </>
          ) : updateInfo?.hasUpdate ? (
            <>
              <Download size={12} />
              {t("appmenu.updateAvailable")}
            </>
          ) : (
            <>
              <RefreshCw size={12} />
              {t("appmenu.checkUpdates")}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

export type { MenuDef };
