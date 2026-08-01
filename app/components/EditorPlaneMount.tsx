"use client";

import { useEffect, useRef } from "react";
import type { BrandContext } from "@/lib/onboarding/types";
import type { EditorInput } from "@/lib/editor-input/types";
import type { EditorPlaneResult, Idea } from "@/lib/types";

type Props = {
  projectId: string;
  editorInput: EditorInput;
  idea: Idea;
  task: string;
  brandText: string;
  assetItems: { assetId: string; name: string; dataUrl: string; url?: string }[];
  brandContext: BrandContext;
  onBack: () => void;
  onFinish: (result: EditorPlaneResult) => void;
};

/**
 * React host for the Vue editor micro-frontend.
 *
 * The editor is intentionally lazy-mounted so the rest of the Next.js app
 * does not need to know anything about Vue. The real OpenPencil runtime can
 * replace VueEditorPlane without changing this host contract.
 */
export default function EditorPlaneMount({ projectId, editorInput, idea, task, brandText, assetItems, brandContext, onBack, onFinish }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onBack, onFinish });
  callbacksRef.current = { onBack, onFinish };

  useEffect(() => {
    let disposed = false;
    let vueApp: { mount: (element: Element) => unknown; unmount: () => void } | undefined;

    Promise.all([import("vue"), import("./VueEditorPlane")]).then(([vue, module]) => {
      if (disposed || !mountRef.current) return;

      vueApp = vue.createApp(module.default, {
        projectId,
        editorInput,
        ideaTitle: idea.title,
        ideaId: idea.id,
        ideaHook: idea.hook,
        ideaDescription: idea.description,
        ideaAssetIds: idea.assetIds ?? [],
        ideaSlides: idea.slides,
        ideaFormat: idea.format,
        ideaAssets: idea.assets,
        task,
        brandText,
        assetItems,
        brandContext,
        onBack: () => callbacksRef.current.onBack(),
        onFinish: (result: EditorPlaneResult) => callbacksRef.current.onFinish(result),
      });
      vueApp.mount(mountRef.current);
    });

    return () => {
      disposed = true;
      vueApp?.unmount();
    };
  }, [assetItems, brandContext, brandText, editorInput, idea.assets, idea.assetIds, idea.description, idea.format, idea.hook, idea.id, idea.slides, idea.title, projectId, task]);

  return <div ref={mountRef} className="vue-editor-mount" aria-label="BMT editor plane" />;
}
