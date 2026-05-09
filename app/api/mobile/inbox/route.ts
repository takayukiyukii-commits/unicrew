import { NextResponse } from "next/server";
import { MOBILE_TOKEN_HEADER } from "@/lib/mobile-bridge";
import type { MobileInboxItem } from "@/lib/mobile-bridge";
import { checkToken, pushInbox, takeInbox } from "../_store";

function readToken(req: Request): string | null {
  const h = req.headers.get(MOBILE_TOKEN_HEADER);
  if (h) return h;
  const url = new URL(req.url);
  return url.searchParams.get("t");
}

/** スマホから新しい依頼を投稿する。 */
export async function POST(req: Request) {
  const tok = readToken(req);
  if (!checkToken(tok)) {
    return NextResponse.json(
      { ok: false, error: "認証に失敗しました（token 不一致）" },
      { status: 401 },
    );
  }
  const body = (await req.json()) as {
    threadId?: string;
    text?: string;
  };
  if (!body.text || !body.text.trim()) {
    return NextResponse.json(
      { ok: false, error: "text が空です" },
      { status: 400 },
    );
  }
  const item: MobileInboxItem = {
    id: `mob-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    createdAt: Date.now(),
    threadId: body.threadId || "active",
    text: body.text.trim(),
  };
  pushInbox(item);
  return NextResponse.json({ ok: true, id: item.id });
}

/** PC側React が定期的にポーリングして取り出す（取り出し後はクリア）。 */
export async function GET(req: Request) {
  const tok = readToken(req);
  if (!checkToken(tok)) {
    return NextResponse.json(
      { ok: false, error: "認証に失敗しました（token 不一致）" },
      { status: 401 },
    );
  }
  const items = takeInbox();
  return NextResponse.json({ ok: true, items });
}
