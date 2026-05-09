import { NextResponse } from "next/server";
import { MOBILE_TOKEN_HEADER } from "@/lib/mobile-bridge";
import type { MobileStateSnapshot } from "@/lib/mobile-bridge";
import { checkToken, getSnapshot, setSnapshot } from "../_store";

function readToken(req: Request): string | null {
  const h = req.headers.get(MOBILE_TOKEN_HEADER);
  if (h) return h;
  const url = new URL(req.url);
  return url.searchParams.get("t");
}

/** PC側React が現在状態を流し込む（thread一覧・最新応答・streaming 状態） */
export async function POST(req: Request) {
  const tok = readToken(req);
  if (!checkToken(tok)) {
    return NextResponse.json(
      { ok: false, error: "認証に失敗しました（token 不一致）" },
      { status: 401 },
    );
  }
  const body = (await req.json()) as MobileStateSnapshot;
  setSnapshot(body);
  return NextResponse.json({ ok: true });
}

/** スマホがポーリング表示する。 */
export async function GET(req: Request) {
  const tok = readToken(req);
  if (!checkToken(tok)) {
    return NextResponse.json(
      { ok: false, error: "認証に失敗しました（token 不一致）" },
      { status: 401 },
    );
  }
  return NextResponse.json({ ok: true, snapshot: getSnapshot() });
}
