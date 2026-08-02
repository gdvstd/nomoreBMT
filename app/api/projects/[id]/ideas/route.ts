import { NextResponse } from "next/server";

import { runMarketerAgent } from "@/lib/marketer-agent";
import { createMarketerBridgeSession } from "@/lib/marketer-agent/bridge-session";
import { marketerAgentInputSchema } from "@/lib/marketer-agent/types";
import { generateTraceId } from "@openai/agents";

export const runtime = "nodejs";
// The marketer now calls the Instagram reference scout (Apify + a nested model
// call) as a one-shot tool, so allow the same budget the scout route used.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 },
    );
  }

  const { id: projectId } = await params;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = marketerAgentInputSchema.safeParse({
    ...(body ?? {}),
    taskId: typeof body?.taskId === "string" ? body.taskId : projectId,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid marketing agent input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const session = createMarketerBridgeSession();
  const runId = crypto.randomUUID();
  const traceId = generateTraceId();
  const groupId = `marketer-project:${projectId}`;

  // Return immediately so the ideas screen can subscribe to run/tool events
  // while the single marketing inference is still in progress.
  void runMarketerAgent(parsed.data, {
    runId,
    traceId,
    groupId,
    onEvent: (event) => session.emitAgentEvent(event),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    session.emitAgentEvent({
      type: "status",
      status: "failed",
      message,
      runId,
      traceId,
    });
    session.emit({ type: "error", message });
  });

  return NextResponse.json({
    status: "MARKETER_AGENT_STARTED",
    projectId,
    runId,
    traceId,
    groupId,
    bridgeSessionId: session.id,
  }, { status: 202 });
}
