import { NextResponse } from "next/server";

import { getEditorBridgeSession } from "@/lib/editor-agent/bridge-session";
import type { EditorAgentMode } from "@/lib/editor-agent/types";

export const runtime = "nodejs";

type Params = { params: Promise<{ sessionId: string }> };

export async function PATCH(request: Request, { params }: Params) {
  const { sessionId } = await params;
  const session = getEditorBridgeSession(sessionId);
  if (!session) {
    return NextResponse.json({ error: "Editor bridge session not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => null) as { mode?: unknown } | null;
  const mode = body?.mode;
  if (mode !== "auto" && mode !== "live" && mode !== "review") {
    return NextResponse.json({ error: "mode must be auto, live, or review" }, { status: 400 });
  }

  session.setMode(mode as EditorAgentMode);
  return NextResponse.json({ ok: true, mode: session.mode });
}
