import { NextResponse } from "next/server";

import { generateBrandProfile } from "@/lib/onboarding/agent";
import {
  brandContextSchema,
  normalizeInstagramHandle,
  onboardingAnswersSchema,
} from "@/lib/onboarding/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const parsed = onboardingAnswersSchema.safeParse({
    ...(body ?? {}),
    instagramHandle:
      typeof body?.instagramHandle === "string"
        ? normalizeInstagramHandle(body.instagramHandle)
        : body?.instagramHandle,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "온보딩 답변을 확인해주세요", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const generated = await generateBrandProfile(parsed.data);
    const context = brandContextSchema.parse({
      ...generated,
      schemaVersion: "1.0",
      accountName: parsed.data.accountName,
      instagramHandle: parsed.data.instagramHandle,
      generatedAt: new Date().toISOString(),
    });

    return NextResponse.json({ status: "BRAND_CONTEXT_READY", context });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
