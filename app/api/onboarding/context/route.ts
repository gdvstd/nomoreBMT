import { NextResponse } from "next/server";

import { generateBrandProfile } from "@/lib/onboarding/agent";
import { buildEditorAgentContext } from "@/lib/marketing-context";
import {
  brandContextSchema,
  normalizeInstagramHandle,
  onboardingAnswersSchema,
} from "@/lib/onboarding/types";

export const runtime = "nodejs";
export const maxDuration = 300;

class ConnectedAccountMismatchError extends Error {
  constructor(inputHandle: string, connectedUsername: string) {
    super(
      `입력한 Instagram ID(@${inputHandle})와 현재 연결된 계정(@${connectedUsername})이 달라요. 연결된 계정을 확인한 뒤 다시 시도해주세요.`,
    );
    this.name = "ConnectedAccountMismatchError";
  }
}

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
    const [generated, ownedAccountContext] = await Promise.all([
      generateBrandProfile(parsed.data),
      buildEditorAgentContext({
        postLimit: 12,
        commentsPerPost: 20,
        focus:
          "온보딩 공통 Agent context에 포함할 기존 계정의 문제점, 시각적 개선점, 유지할 패턴을 근거 중심으로 추출",
      }),
    ]);
    const inputHandle = normalizeInstagramHandle(parsed.data.instagramHandle).toLowerCase();
    const connectedHandle = normalizeInstagramHandle(
      ownedAccountContext.account.username,
    ).toLowerCase();
    if (inputHandle !== connectedHandle) {
      throw new ConnectedAccountMismatchError(
        parsed.data.instagramHandle,
        ownedAccountContext.account.username,
      );
    }
    const context = brandContextSchema.parse({
      ...generated,
      schemaVersion: "1.0",
      accountName: parsed.data.accountName,
      instagramHandle: parsed.data.instagramHandle,
      generatedAt: new Date().toISOString(),
      ownedAccountContext,
    });

    return NextResponse.json({ status: "BRAND_CONTEXT_READY", context });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      {
        status:
          error instanceof ConnectedAccountMismatchError ? 409 : 502,
      },
    );
  }
}
