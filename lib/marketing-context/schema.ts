export type EvidenceFinding = {
  finding: string;
  evidencePostIds: string[];
  metricBasis: string;
  confidence: number;
};

export type CommentTheme = {
  theme: string;
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  frequencySignal: string;
  evidenceCommentIds: string[];
};

export type SlideVisualFinding = {
  postId: string;
  slideId: string;
  slideIndex: number;
  summary: string;
  textReadability: string;
  contrast: string;
  hierarchy: string;
  spacing: string;
  issues: string[];
  strengths: string[];
  severity: "none" | "low" | "medium" | "high";
};

export type ModelMarketingAnalysis = {
  accountSummary: {
    positioning: string;
    audienceProfile: string;
    observedTone: string[];
    recurringTopics: string[];
  };
  performanceSummary: {
    overview: string;
    winningPatterns: EvidenceFinding[];
    weakPatterns: EvidenceFinding[];
    formatFindings: string[];
    timingFindings: string[];
  };
  audienceResponse: {
    likedAspects: string[];
    frictionPoints: string[];
    repeatedQuestions: string[];
    audienceVocabulary: string[];
    commentThemes: CommentTheme[];
  };
  visualAnalysis: {
    overview: string;
    slides: SlideVisualFinding[];
    carousels: Array<{
      postId: string;
      sequenceQuality: string;
      sequenceIssues: string[];
      recommendedOrder: string[];
      overallVisualScore: number;
    }>;
    accountLevelPatterns: string[];
    priorityFixes: string[];
  };
  editorContext: {
    creativePrinciples: string[];
    doMore: string[];
    avoid: string[];
    recommendedFormats: string[];
    copyGuidelines: string[];
    visualGuidelines: string[];
    evidenceRules: string[];
  };
  dataQuality: {
    coverage: string;
    limitations: string[];
  };
};

const stringArray = (maxItems: number) => ({
  type: "array",
  items: { type: "string" },
  maxItems,
});

const evidenceFindingSchema = {
  type: "object",
  properties: {
    finding: { type: "string" },
    evidencePostIds: stringArray(8),
    metricBasis: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["finding", "evidencePostIds", "metricBasis", "confidence"],
  additionalProperties: false,
};

export const marketingContextJsonSchema = {
  type: "object",
  properties: {
    accountSummary: {
      type: "object",
      properties: {
        positioning: { type: "string" },
        audienceProfile: { type: "string" },
        observedTone: stringArray(8),
        recurringTopics: stringArray(12),
      },
      required: ["positioning", "audienceProfile", "observedTone", "recurringTopics"],
      additionalProperties: false,
    },
    performanceSummary: {
      type: "object",
      properties: {
        overview: { type: "string" },
        winningPatterns: {
          type: "array",
          items: evidenceFindingSchema,
          maxItems: 8,
        },
        weakPatterns: {
          type: "array",
          items: evidenceFindingSchema,
          maxItems: 8,
        },
        formatFindings: stringArray(8),
        timingFindings: stringArray(8),
      },
      required: [
        "overview",
        "winningPatterns",
        "weakPatterns",
        "formatFindings",
        "timingFindings",
      ],
      additionalProperties: false,
    },
    audienceResponse: {
      type: "object",
      properties: {
        likedAspects: stringArray(10),
        frictionPoints: stringArray(10),
        repeatedQuestions: stringArray(10),
        audienceVocabulary: stringArray(16),
        commentThemes: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              theme: { type: "string" },
              sentiment: {
                type: "string",
                enum: ["positive", "neutral", "negative", "mixed"],
              },
              frequencySignal: { type: "string" },
              evidenceCommentIds: stringArray(10),
            },
            required: ["theme", "sentiment", "frequencySignal", "evidenceCommentIds"],
            additionalProperties: false,
          },
        },
      },
      required: [
        "likedAspects",
        "frictionPoints",
        "repeatedQuestions",
        "audienceVocabulary",
        "commentThemes",
      ],
      additionalProperties: false,
    },
    visualAnalysis: {
      type: "object",
      properties: {
        overview: { type: "string" },
        slides: {
          type: "array",
          maxItems: 30,
          items: {
            type: "object",
            properties: {
              postId: { type: "string" },
              slideId: { type: "string" },
              slideIndex: { type: "integer" },
              summary: { type: "string" },
              textReadability: { type: "string" },
              contrast: { type: "string" },
              hierarchy: { type: "string" },
              spacing: { type: "string" },
              issues: stringArray(8),
              strengths: stringArray(8),
              severity: {
                type: "string",
                enum: ["none", "low", "medium", "high"],
              },
            },
            required: [
              "postId",
              "slideId",
              "slideIndex",
              "summary",
              "textReadability",
              "contrast",
              "hierarchy",
              "spacing",
              "issues",
              "strengths",
              "severity",
            ],
            additionalProperties: false,
          },
        },
        carousels: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              postId: { type: "string" },
              sequenceQuality: { type: "string" },
              sequenceIssues: stringArray(8),
              recommendedOrder: stringArray(15),
              overallVisualScore: { type: "number", minimum: 0, maximum: 100 },
            },
            required: [
              "postId",
              "sequenceQuality",
              "sequenceIssues",
              "recommendedOrder",
              "overallVisualScore",
            ],
            additionalProperties: false,
          },
        },
        accountLevelPatterns: stringArray(10),
        priorityFixes: stringArray(10),
      },
      required: [
        "overview",
        "slides",
        "carousels",
        "accountLevelPatterns",
        "priorityFixes",
      ],
      additionalProperties: false,
    },
    editorContext: {
      type: "object",
      properties: {
        creativePrinciples: stringArray(10),
        doMore: stringArray(10),
        avoid: stringArray(10),
        recommendedFormats: stringArray(8),
        copyGuidelines: stringArray(10),
        visualGuidelines: stringArray(10),
        evidenceRules: stringArray(8),
      },
      required: [
        "creativePrinciples",
        "doMore",
        "avoid",
        "recommendedFormats",
        "copyGuidelines",
        "visualGuidelines",
        "evidenceRules",
      ],
      additionalProperties: false,
    },
    dataQuality: {
      type: "object",
      properties: {
        coverage: { type: "string" },
        limitations: stringArray(12),
      },
      required: ["coverage", "limitations"],
      additionalProperties: false,
    },
  },
  required: [
    "accountSummary",
    "performanceSummary",
    "audienceResponse",
    "visualAnalysis",
    "editorContext",
    "dataQuality",
  ],
  additionalProperties: false,
} as const;
