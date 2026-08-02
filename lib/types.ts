import type {
  MarketerComplianceCheck,
  MarketerIdeaCard,
  MarketerReference,
} from "@/lib/marketer-agent/types";

export type Screen = "onboarding" | "dashboard" | "brief" | "ideas" | "editor" | "review";

/** An idea card now carries a fully-authored slide plan (see MarketerIdeaCard). */
export type Idea = MarketerIdeaCard;
export type Reference = MarketerReference;
export type ComplianceCheck = MarketerComplianceCheck;

export type RenderedPost = {
  ideaId: string;
  slides: {
    nodeId?: string;
    eyebrow: string;
    title: string;
    copy: string;
    gradient: string;
    assetIds?: string[];
    imageDataUrl?: string;
  }[];
  caption: string;
  previewImageUrl?: string;
  diagnostics?: EditorDiagnostics;
};

export type EditorDiagnostics = {
  plannerTraceId?: string;
  editorTraceId?: string;
  selectedIdea: Idea;
  eventLog: Array<{
    kind: "reasoning" | "tool" | "status";
    label: string;
    detail?: string;
  }>;
  finalOutput?: unknown;
};

export type EditorPlaneResult = {
  slides: Array<{
    index: number;
    nodeId: string;
    eyebrow: string;
    title: string;
    copy: string;
    assetIds: string[];
    imageDataUrl: string;
  }>;
  caption: string;
  contactSheetImageUrl?: string;
  summary?: string;
  diagnostics?: EditorDiagnostics;
};
