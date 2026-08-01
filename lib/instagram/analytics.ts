import type {
  DeterministicAnalysis,
  InstagramDataset,
  InstagramPost,
  PostPerformance,
  RateMetrics,
} from "./types";

function median(values: number[]) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function rate(value: number | null, reach: number | null) {
  if (value === null || reach === null || reach <= 0) return null;
  return Number((value / reach).toFixed(6));
}

function ratesFor(post: InstagramPost): RateMetrics {
  const { metrics } = post;
  return {
    engagementRateByReach: rate(
      metrics.totalInteractions ?? metrics.likes + metrics.comments,
      metrics.reach,
    ),
    likeRateByReach: rate(metrics.likes, metrics.reach),
    commentRateByReach: rate(metrics.comments, metrics.reach),
    saveRateByReach: rate(metrics.saved, metrics.reach),
    shareRateByReach: rate(metrics.shares, metrics.reach),
  };
}

function scoreFor(post: InstagramPost, rates: RateMetrics) {
  if (rates.engagementRateByReach !== null) return rates.engagementRateByReach;
  return Math.log1p(post.metrics.likes + post.metrics.comments * 2) / 100;
}

export function analyzeInstagramDataset(
  dataset: InstagramDataset,
): DeterministicAnalysis {
  const scored = dataset.posts
    .map((post) => {
      const rates = ratesFor(post);
      return { postId: post.id, score: scoreFor(post, rates), rates };
    })
    .sort((a, b) => a.score - b.score);

  const performance: PostPerformance[] = scored.map((item, index) => {
    const percentile = scored.length <= 1 ? 100 : (index / (scored.length - 1)) * 100;
    return {
      ...item,
      score: Number(item.score.toFixed(6)),
      percentile: Math.round(percentile),
      label: percentile >= 75 ? "top" : percentile <= 25 ? "low" : "typical",
    };
  });

  const postById = new Map(dataset.posts.map((post) => [post.id, post]));
  const orderedByTimestamp = [...dataset.posts].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );

  const metricRates = orderedByTimestamp.map(ratesFor);
  return {
    baseline: {
      analyzedPostCount: dataset.posts.length,
      analyzedCommentCount: dataset.posts.reduce(
        (total, post) => total + post.comments.length,
        0,
      ),
      postsWithReach: dataset.posts.filter((post) => (post.metrics.reach || 0) > 0).length,
      medianLikes: median(dataset.posts.map((post) => post.metrics.likes)) || 0,
      medianComments: median(dataset.posts.map((post) => post.metrics.comments)) || 0,
      medianReach: median(
        dataset.posts
          .map((post) => post.metrics.reach)
          .filter((value): value is number => value !== null),
      ),
      medianSaveRate: median(
        metricRates
          .map((item) => item.saveRateByReach)
          .filter((value): value is number => value !== null),
      ),
      medianShareRate: median(
        metricRates
          .map((item) => item.shareRateByReach)
          .filter((value): value is number => value !== null),
      ),
      medianEngagementRate: median(
        metricRates
          .map((item) => item.engagementRateByReach)
          .filter((value): value is number => value !== null),
      ),
    },
    performance,
    topPostIds: performance
      .filter((item) => item.label === "top")
      .sort((a, b) => b.score - a.score)
      .map((item) => item.postId)
      .filter((id) => postById.has(id)),
    lowPostIds: performance
      .filter((item) => item.label === "low")
      .sort((a, b) => a.score - b.score)
      .map((item) => item.postId)
      .filter((id) => postById.has(id)),
  };
}

