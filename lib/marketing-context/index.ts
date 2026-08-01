import { analyzeInstagramDataset } from "@/lib/instagram/analytics";
import { collectInstagramData } from "@/lib/instagram/client";
import type { InstagramPost } from "@/lib/instagram/types";
import { generateMarketingContext } from "./openai";
import type { ModelMarketingAnalysis } from "./schema";

export type EditorAgentContext = {
  schemaVersion: "1.0";
  generatedAt: string;
  source: "instagram";
  account: {
    id: string;
    username: string;
    accountType: string;
    followersCount: number | null;
    totalMediaCount: number | null;
  };
  coverage: {
    analyzedPostCount: number;
    analyzedCommentCount: number;
    postsWithReach: number;
    analyzedImageCount: number;
    warnings: string[];
  };
  baseline: ReturnType<typeof analyzeInstagramDataset>["baseline"];
  analysis: ModelMarketingAnalysis;
  evidencePosts: Array<
    Pick<
      InstagramPost,
      "id" | "caption" | "mediaType" | "mediaProductType" | "permalink" | "timestamp" | "metrics"
    >
  >;
};

type BuildContextOptions = {
  postLimit: number;
  commentsPerPost: number;
  focus: string;
};

export async function buildEditorAgentContext(
  options: BuildContextOptions,
): Promise<EditorAgentContext> {
  const dataset = await collectInstagramData(options);
  if (!dataset.posts.length) {
    throw new Error("분석할 Instagram 게시물이 없습니다.");
  }

  const deterministic = analyzeInstagramDataset(dataset);
  const modelAnalysis = await generateMarketingContext(
    dataset,
    deterministic,
    options.focus,
  );

  return {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    source: "instagram",
    account: {
      id: dataset.profile.id,
      username: dataset.profile.username,
      accountType: dataset.profile.accountType,
      followersCount: dataset.profile.followersCount,
      totalMediaCount: dataset.profile.mediaCount,
    },
    coverage: {
      analyzedPostCount: deterministic.baseline.analyzedPostCount,
      analyzedCommentCount: deterministic.baseline.analyzedCommentCount,
      postsWithReach: deterministic.baseline.postsWithReach,
      analyzedImageCount: dataset.posts.reduce(
        (total, post) => total + post.slides.filter((slide) => slide.imageUrl).length,
        0,
      ),
      warnings: dataset.warnings,
    },
    baseline: deterministic.baseline,
    analysis: modelAnalysis,
    evidencePosts: dataset.posts.map((post) => ({
      id: post.id,
      caption: post.caption,
      mediaType: post.mediaType,
      mediaProductType: post.mediaProductType,
      permalink: post.permalink,
      timestamp: post.timestamp,
      metrics: post.metrics,
    })),
  };
}
