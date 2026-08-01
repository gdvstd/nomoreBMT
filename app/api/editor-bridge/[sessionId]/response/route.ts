import { NextResponse } from "next/server";

import { getEditorBridgeSession } from "@/lib/editor-agent/bridge-session";

export const runtime = "nodejs";

type Params = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, { params }: Params) {
  const { sessionId } = await params;
  const session = getEditorBridgeSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Editor bridge session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null) as {
    requestId?: unknown;
    result?: unknown;
    graphRevision?: unknown;
    error?: unknown;
  } | null;

  if (!body || typeof body.requestId !== "string") {
    return NextResponse.json({ error: "requestId is required" }, { status: 400 });
  }

  if (typeof body.error === "string" && body.error) {
    session.reject(body.requestId, body.error);
  } else {
    session.respond(body.requestId, {
      result: body.result,
      graphRevision: typeof body.graphRevision === "string" ? body.graphRevision : undefined,
    });
  }

  return NextResponse.json({ ok: true });
}
