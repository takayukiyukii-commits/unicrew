import { NextResponse } from "next/server";
import { setToken } from "../_store";

/** PC側React が起動時に POST して token を登録する。 */
export async function POST(req: Request) {
  const body = (await req.json()) as { token?: string };
  if (!body.token || typeof body.token !== "string" || body.token.length < 16) {
    return NextResponse.json(
      { ok: false, error: "token が短すぎます" },
      { status: 400 },
    );
  }
  setToken(body.token);
  return NextResponse.json({ ok: true });
}
