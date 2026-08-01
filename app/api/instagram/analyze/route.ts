import { NextResponse } from "next/server";
import { InstagramApiError } from "@/lib/instagram/client";
import { buildEditorAgentContext } from "@/lib/marketing-context";
import { OpenAIAnalysisError } from "@/lib/marketing-context/openai";

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";

function configured(name: string) {
  return Boolean(process.env[name]?.trim());
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export async function GET() {
  return NextResponse.json(
    {
      configured: {
        instagram: configured("INSTAGRAM_ACCESS_TOKEN"),
        openai: configured("OPENAI_API_KEY"),
      },
      defaults: {
        postLimit: 12,
        commentsPerPost: 20,
        instagramApiVersion: process.env.INSTAGRAM_API_VERSION || "v23.0",
        openaiModel: process.env.OPENAI_MODEL || "gpt-5.6",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const context = await buildEditorAgentContext({
      postLimit: clampInteger(body.postLimit, 12, 1, 30),
      commentsPerPost: clampInteger(body.commentsPerPost, 20, 0, 50),
      focus:
        typeof body.focus === "string"
          ? body.focus.trim().slice(0, 1_000)
          : "",
    });

    return NextResponse.json(
      { status: "CONTEXT_READY", context },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[instagram-analysis]", error instanceof Error ? error.message : error);

    if (error instanceof InstagramApiError) {
      return NextResponse.json(
        {
          error: "Instagram 데이터를 불러오지 못했습니다.",
          detail: error.message,
          providerCode: error.code || null,
        },
        { status: error.status === 401 ? 401 : 502 },
      );
    }

    if (error instanceof OpenAIAnalysisError) {
      return NextResponse.json(
        {
          error: "OpenAI가 마케팅 context를 생성하지 못했습니다.",
          detail: error.message,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        error: "Instagram 분석 중 오류가 발생했습니다.",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

