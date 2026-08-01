import { NextResponse } from "next/server";

import {
  runEditorAgent,
} from "@/lib/editor-agent";
import {
  createEditorBridgeSession,
  createSessionBridge,
} from "@/lib/editor-agent/bridge-session";
import { editorAgentInputSchema } from "@/lib/editor-agent/types";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/**
 * Start an editor-agent run. The agent is intentionally separated from the
 * browser canvas: tool calls are delivered through the bridge SSE endpoint so
 * the Vue/OpenPencil plane remains the authoritative document owner.
 */
export async function POST(request: Request, { params }: Params) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 },
    );
  }

  const { id: projectId } = await params;
  const body = await request.json().catch(() => null);
  const parsed = editorAgentInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid editor agent input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const session = createEditorBridgeSession();
  const runId = crypto.randomUUID();
  const input = parsed.data;

  // Start asynchronously so the caller can immediately open the bridge
  // stream and receive the first inspection tool call.
  void runEditorAgent(input, {
    bridge: createSessionBridge(session),
    runId,
    mode: session.mode,
    onEvent: (event) => session.emitAgentEvent(event),
  }).catch((error) => {
    session.emitAgentEvent({
      type: "status",
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
    session.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  });

  return NextResponse.json({
    status: "EDITOR_AGENT_STARTED",
    projectId,
    runId,
    bridgeSessionId: session.id,
  }, { status: 202 });
}
