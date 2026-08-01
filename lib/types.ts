export type Screen = "onboarding" | "dashboard" | "brief" | "ideas" | "editor" | "review";

export type Idea = {
  id: string;
  label: string;
  title: string;
  hook: string;
  description: string;
  format: string;
  assets: string[];
  slides: string[];
  accent: "coral" | "blue";
};

export type RenderedPost = {
  ideaId: string;
  slides: { eyebrow: string; title: string; copy: string; gradient: string }[];
  caption: string;
};
