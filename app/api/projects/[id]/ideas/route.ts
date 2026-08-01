import { NextResponse } from "next/server";

import { runMarketerAgent } from "@/lib/marketer-agent";
import { marketerAgentInputSchema } from "@/lib/marketer-agent/types";

export const runtime = "nodejs";
export const maxDuration = 120;

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

  try {
    const output = await runMarketerAgent(parsed.data);
    return NextResponse.json({ status: "IDEAS_READY", ...output });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
