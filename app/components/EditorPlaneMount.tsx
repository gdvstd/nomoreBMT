"use client";

import { useEffect, useRef } from "react";
import type { Idea } from "@/lib/types";

type Props = {
  idea: Idea;
  task: string;
  brandText: string;
  assetNames: string[];
  onBack: () => void;
  onFinish: () => void;
};

/**
 * React host for the Vue editor micro-frontend.
 *
 * The editor is intentionally lazy-mounted so the rest of the Next.js app
 * does not need to know anything about Vue. The real OpenPencil runtime can
 * replace VueEditorPlane without changing this host contract.
 */
export default function EditorPlaneMount({ idea, task, brandText, assetNames, onBack, onFinish }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onBack, onFinish });
  callbacksRef.current = { onBack, onFinish };

  useEffect(() => {
    let disposed = false;
    let vueApp: { mount: (element: Element) => unknown; unmount: () => void } | undefined;

    Promise.all([import("vue"), import("./VueEditorPlane")]).then(([vue, module]) => {
      if (disposed || !mountRef.current) return;

      vueApp = vue.createApp(module.default, {
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
        assetNames,
        onBack: () => callbacksRef.current.onBack(),
        onFinish: () => callbacksRef.current.onFinish(),
      });
      vueApp.mount(mountRef.current);
    });

    return () => {
      disposed = true;
      vueApp?.unmount();
    };
  }, [assetNames, brandText, idea.assets, idea.assetIds, idea.description, idea.format, idea.hook, idea.id, idea.slides, idea.title, task]);

  return <div ref={mountRef} className="vue-editor-mount" aria-label="BMT editor plane" />;
}
