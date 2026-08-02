import { tool } from "@openai/agents";
import { z } from "zod";

import { scoutInstagramReferences } from "@/lib/reference-scout/openai";
import type { InstagramReferenceContext } from "@/lib/reference-scout/schema";

import type { MarketerAgentEvent, MarketerReference } from "./types";

const SCOUT_TOOL_NAME = "scout_instagram_references";

/**
 * Server-fixed reference-search parameters. The marketer only decides topic,
 * purpose, and searchTerms; these stay constant so the model cannot widen or
 * narrow the search.
 */
export const researchDefaults = {
  region: "KR" as const,
  formatFocus: "carousel" as const,
  maxReferences: 3 as const,
  timeRange: "30d" as const,
};

/** Holds the single scout result for one marketer run. */
export type ResearchCapture = {
  context: InstagramReferenceContext | null;
  called: boolean;
};

export function createResearchCapture(): ResearchCapture {
  return { context: null, called: false };
}

/** A stable per-run reference id the model cites and the server echoes. */
function referenceId(rank: number) {
  return `reference-${rank}`;
}

/** Build the trustworthy output references from the scout result. */
export function marketerReferencesFromContext(
  context: InstagramReferenceContext | null,
): MarketerReference[] {
  if (!context) return [];
  return context.references.map((reference) => {
    const transferable = reference.creativeAnalysis.transferableElements;
    const visual = reference.creativeAnalysis.visualPatterns;
    return {
      id: referenceId(reference.rank),
      instagramUrl: reference.instagramUrl,
      creatorHandle: reference.creatorHandle,
      previewImageUrl: reference.previewImageUrls?.[0] ?? null,
      borrowedPatterns: (transferable.length ? transferable : visual).slice(0, 6),
    };
  });
}

/** A compact, model-facing view of the scout result. */
function compactScoutForModel(context: InstagramReferenceContext) {
  return {
    searchSummary: {
      queries: context.searchSummary.queries,
      confidence: context.searchSummary.confidence,
      verifiedReferenceCount: context.searchSummary.verifiedReferenceCount,
      limitations: context.searchSummary.limitations,
    },
    references: context.references.map((reference) => ({
      referenceId: referenceId(reference.rank),
      instagramUrl: reference.instagramUrl,
      creatorHandle: reference.creatorHandle,
      topicSummary: reference.topicSummary,
      performanceSignal: reference.performanceSignal,
      hook: reference.creativeAnalysis.hook,
      contentStructure: reference.creativeAnalysis.contentStructure,
      visualPatterns: reference.creativeAnalysis.visualPatterns,
      transferableElements: reference.creativeAnalysis.transferableElements,
      avoidCopying: reference.creativeAnalysis.avoidCopying,
    })),
    patterns: context.patterns.map((pattern) => ({
      pattern: pattern.pattern,
      whyItMayWork: pattern.whyItMayWork,
    })),
    editorContext: context.editorContext,
  };
}

const scoutParametersSchema = z.object({
  topic: z
    .string()
    .min(2)
    .describe("The specific research subject, e.g. '삿포로 여행 음식 기록 인스타그램 캐러셀'."),
  purpose: z
    .string()
    .min(2)
    .describe("What you want to learn from references: hook, sequence, crop, typography patterns."),
  searchTerms: z
    .array(z.string().min(2))
    .min(1)
    .max(5)
    .describe("Korean search phrases likely to surface similar public carousels."),
});

/**
 * The marketer's only research tool. It may be called EXACTLY ONCE per run;
 * region, format, recency, and count are fixed by researchDefaults. Failures
 * degrade gracefully so the marketer finishes from the user's photos alone.
 */
export function createScoutTool(
  capture: ResearchCapture,
  onEvent?: (event: MarketerAgentEvent) => void,
) {
  return tool({
    name: SCOUT_TOOL_NAME,
    description:
      "Search public Instagram for topic-matched carousel references. Call EXACTLY ONCE, after you decide topic, purpose, and searchTerms. Region (KR), carousel format, 30-day recency, and reference count are fixed server-side and cannot be changed. Do not call it again even if few references return.",
    parameters: scoutParametersSchema,
    strict: true,
    execute: async ({ topic, purpose, searchTerms }) => {
      onEvent?.({
        type: "tool_started",
        toolName: SCOUT_TOOL_NAME,
        args: { topic, purpose, searchTerms },
      });
      if (capture.called) {
        onEvent?.({
          type: "tool_finished",
          toolName: SCOUT_TOOL_NAME,
          resultSummary: "이미 1회 호출됨 · 재호출 차단",
        });
        return {
          note: "scout_instagram_references는 1회만 호출할 수 있어요. 이미 확보한 근거와 사용자 사진으로 두 방향을 완성하세요.",
          references: [],
          patterns: [],
          editorContext: null,
        };
      }
      capture.called = true;
      try {
        const context = await scoutInstagramReferences({
          topic,
          objective: purpose,
          searchTerms,
          ...researchDefaults,
        });
        capture.context = context;
        onEvent?.({
          type: "tool_finished",
          toolName: SCOUT_TOOL_NAME,
          resultSummary: `${context.references.length}개 레퍼런스 · confidence=${context.searchSummary.confidence} · provider=${context.searchSummary.provider} · 쿼리 [${context.searchSummary.queries.join(", ")}]`,
        });
        return compactScoutForModel(context);
      } catch (error) {
        capture.context = null;
        onEvent?.({
          type: "tool_finished",
          toolName: SCOUT_TOOL_NAME,
          resultSummary: `검색 실패 · ${error instanceof Error ? error.message : "unknown"}`,
        });
        return {
          note: `레퍼런스 검색에 실패했어요(${error instanceof Error ? error.message : "unknown"}). 사용자 사진과 브랜드 근거만으로 두 방향을 완성하세요.`,
          references: [],
          patterns: [],
          editorContext: null,
        };
      }
    },
  });
}
