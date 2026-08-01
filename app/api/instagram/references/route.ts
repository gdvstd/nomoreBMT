import { NextResponse } from "next/server";
import {
  ReferenceScoutError,
  scoutInstagramReferences,
} from "@/lib/reference-scout/openai";
import type { ReferenceScoutInput } from "@/lib/reference-scout/schema";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const timeRanges = new Set<ReferenceScoutInput["timeRange"]>([
  "7d",
  "30d",
  "90d",
  "any",
]);
const formatFocuses = new Set<ReferenceScoutInput["formatFocus"]>([
  "carousel",
  "reel",
  "single_image",
  "all",
]);

function stringValue(value: unknown, fallback: string, maxLength: number) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const topic = stringValue(body.topic, "", 500);
    if (topic.length < 2) {
      return NextResponse.json(
        { error: "검색할 게시물 주제를 2자 이상 입력해 주세요." },
        { status: 400 },
      );
    }

    const requestedTimeRange = stringValue(body.timeRange, "30d", 8);
    const requestedFormat = stringValue(body.formatFocus, "carousel", 20);
    const input: ReferenceScoutInput = {
      topic,
      objective: stringValue(body.objective, "", 500),
      timeRange: timeRanges.has(
        requestedTimeRange as ReferenceScoutInput["timeRange"],
      )
        ? (requestedTimeRange as ReferenceScoutInput["timeRange"])
        : "30d",
      region: stringValue(body.region, "KR", 50) || "KR",
      formatFocus: formatFocuses.has(
        requestedFormat as ReferenceScoutInput["formatFocus"],
      )
        ? (requestedFormat as ReferenceScoutInput["formatFocus"])
        : "carousel",
      maxReferences: clampInteger(body.maxReferences, 3, 1, 3),
    };

    const context = await scoutInstagramReferences(input);
    return NextResponse.json(
      { status: "REFERENCE_CONTEXT_READY", context },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(
      "[instagram-reference-scout]",
      error instanceof Error ? error.message : error,
    );

    if (error instanceof ReferenceScoutError) {
      return NextResponse.json(
        {
          error: "Instagram reference를 검색하지 못했습니다.",
          detail: error.message,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        error: "Reference 검색 중 오류가 발생했습니다.",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
