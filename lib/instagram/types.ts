export type InstagramProfile = {
  id: string;
  username: string;
  accountType: string;
  followersCount: number | null;
  mediaCount: number | null;
};

export type InstagramComment = {
  id: string;
  text: string;
  timestamp: string | null;
  likeCount: number;
};

export type InstagramMetrics = {
  likes: number;
  comments: number;
  reach: number | null;
  saved: number | null;
  shares: number | null;
  totalInteractions: number | null;
  views: number | null;
};

export type InstagramSlide = {
  id: string;
  slideIndex: number;
  mediaType: string;
  imageUrl: string | null;
};

export type InstagramPost = {
  id: string;
  caption: string;
  mediaType: string;
  mediaProductType: string;
  permalink: string;
  previewUrl: string | null;
  timestamp: string;
  metrics: InstagramMetrics;
  comments: InstagramComment[];
  slides: InstagramSlide[];
};

export type InstagramDataset = {
  profile: InstagramProfile;
  posts: InstagramPost[];
  warnings: string[];
  collectedAt: string;
};

export type RateMetrics = {
  engagementRateByReach: number | null;
  likeRateByReach: number | null;
  commentRateByReach: number | null;
  saveRateByReach: number | null;
  shareRateByReach: number | null;
};

export type PostPerformance = {
  postId: string;
  score: number;
  percentile: number;
  label: "top" | "typical" | "low";
  rates: RateMetrics;
};

export type DeterministicAnalysis = {
  baseline: {
    analyzedPostCount: number;
    analyzedCommentCount: number;
    postsWithReach: number;
    medianLikes: number;
    medianComments: number;
    medianReach: number | null;
    medianSaveRate: number | null;
    medianShareRate: number | null;
    medianEngagementRate: number | null;
  };
  performance: PostPerformance[];
  topPostIds: string[];
  lowPostIds: string[];
};
