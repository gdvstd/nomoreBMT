export type Screen = "onboarding" | "dashboard" | "brief" | "ideas" | "editor" | "review";

export type Idea = {
  id: string;
  label: string;
  title: string;
  hook: string;
  description: string;
  format: string;
  assets: string[];
  assetIds?: string[];
  slides: string[];
  accent: "coral" | "blue";
};

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
};
