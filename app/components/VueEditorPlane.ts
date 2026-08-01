import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import { ALL_TOOLS, CORE_TOOLS, type ToolDef } from "@open-pencil/core/tools";
import { FigmaAPI } from "@open-pencil/core/figma-api";
import { createEditor, type Tool } from "@open-pencil/core/editor";
import { renderNodesToImage, type RasterExportFormat } from "../../node_modules/@open-pencil/core/dist/io/formats/raster/render.js";
import type { EditorPlaneResult } from "@/lib/types";
// Import the two focused Vue composable modules directly. OpenPencil 0.13.2's
// package barrel currently references optional worker files that are not shipped
// in the npm tarball; the canvas modules themselves are complete and browser-safe.
// @ts-expect-error OpenPencil's package export omits declarations for this focused module.
import { provideEditor, useCanvas } from "../../node_modules/@open-pencil/vue/dist/canvas/CanvasRoot.js";
// @ts-expect-error OpenPencil's package export omits declarations for this focused module.
import { useCanvasInput } from "../../node_modules/@open-pencil/vue/dist/canvas/useCanvasInput.js";

type Mode = "auto" | "live" | "review";

type Props = {
  ideaId: string;
  ideaTitle: string;
  ideaHook: string;
  ideaDescription: string;
  ideaAssetIds: string[];
  ideaSlides: string[];
  ideaFormat: string;
  ideaAssets: string[];
  task: string;
  brandText: string;
  assetItems: { name: string; dataUrl: string }[];
  onBack: () => void;
  onFinish: (result: EditorPlaneResult) => void;
};

type AgentOutput = {
  status?: "completed" | "needs_input" | "failed";
  cardRoots?: Array<{ index?: number; nodeId?: string; purpose?: string; assetIds?: string[] }>;
  slides?: Array<{ index?: number; nodeId?: string; title?: string; copy?: string; assetIds?: string[] }>;
  caption?: string;
  summary?: string;
  warnings?: string[];
  unresolved?: string[];
};

type CarouselValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  cards: Array<{
    index: number;
    nodeId: string;
    type?: string;
    width?: number;
    height?: number;
    childCount: number;
    hasImage: boolean;
  }>;
};

const modeCopy: Record<Mode, { label: string; caption: string; description: string }> = {
  auto: { label: "Auto", caption: "자동 진행", description: "편집 과정은 접어두고, 완성될 때까지 BMT가 작업을 진행해요." },
  live: { label: "Live", caption: "실시간 편집", description: "사진을 자르고 배치하는 과정을 캔버스에서 실시간으로 확인해요." },
  review: { label: "Review", caption: "최종 검토", description: "완성된 레이어를 확인하고, 게시하기 전에 직접 다듬을 수 있어요." },
};

type PlanStep = {
  id: string;
  label: string;
  detail?: string;
  status?: "pending" | "active" | "complete" | "blocked";
};

type AgentLogEntry = {
  id: string;
  kind: "reasoning" | "tool" | "status";
  label: string;
  detail?: string;
};

const planningStep: PlanStep = {
  id: "planning",
  label: "편집 계획 수립",
  detail: "에이전트가 작업 순서를 정하고 있어요.",
  status: "active",
};

function childText(text: string, className = "") {
  return h("span", { class: className }, text);
}

const VueEditorPlane = defineComponent({
  name: "VueEditorPlane",
  props: {
    ideaId: { type: String, required: true },
    ideaTitle: { type: String, required: true },
    ideaHook: { type: String, required: true },
    ideaDescription: { type: String, required: true },
    ideaAssetIds: { type: Array, required: true },
    ideaSlides: { type: Array, required: true },
    ideaFormat: { type: String, required: true },
    ideaAssets: { type: Array, required: true },
    task: { type: String, required: true },
    brandText: { type: String, required: true },
    assetItems: { type: Array, required: true },
    onBack: { type: Function, required: true },
    onFinish: { type: Function, required: true },
  },
  setup(props: Props) {
    const mode = ref<Mode>("auto");
    const progress = ref(0);
    const planSteps = ref<PlanStep[]>([planningStep]);
    const currentReasoning = ref("에이전트가 작업 순서를 준비하고 있어요.");
    const recentTool = ref("호출 대기 중");
    const agentEventLog = ref<AgentLogEntry[]>([]);
    const streamedAgentText = ref("");
    const selectedLayer = ref("headline");
    const activeTool = ref<Tool>("SELECT");
    const canvasViewportSize = { width: 960, height: 620 };
    const editor = createEditor({
      getViewportSize: () => ({ ...canvasViewportSize }),
    });
    let resolveRendererReady: (() => void) | undefined;
    const rendererReady = new Promise<void>((resolve) => {
      resolveRendererReady = resolve;
    });
    const figma = new FigmaAPI(editor.graph);
    figma.exportImage = async (nodeIds, options) => {
      const renderer = editor.renderer;
      if (!renderer) throw new Error("OpenPencil canvas renderer is not ready");

      renderer.invalidateAllPictures();
      const restoreTextMeasurer = await renderer.prepareForExport(
        editor.graph,
        figma.currentPageId,
        nodeIds,
      );
      try {
        return renderNodesToImage(
          renderer.ck,
          renderer,
          editor.graph,
          figma.currentPageId,
          nodeIds,
          {
            scale: options.scale ?? 1,
            format: (options.format ?? "PNG") as RasterExportFormat,
            quality: options.quality,
          },
        );
      } finally {
        restoreTextMeasurer();
      }
    };
    const agentConnected = ref(false);
    const agentError = ref("");
    const agentSessionId = ref<string | null>(null);
    const agentTraceId = ref<string | null>(null);
    let agentStream: EventSource | undefined;
    let agentEventSequence = 0;
    const exportedImage = ref<string | null>(null);
    const exportedCardImages = ref<string[]>([]);
    const finalAgentOutput = ref<AgentOutput | null>(null);
    const assetCloneIds = new Set<string>();

    function pushAgentEvent(kind: AgentLogEntry["kind"], label: string, detail?: string) {
      agentEventLog.value = [{
        id: `${Date.now()}-${agentEventSequence++}`,
        kind,
        label,
        detail,
      }, ...agentEventLog.value].slice(0, 50);
    }

    function readableToolDetail(value: unknown) {
      if (value === undefined || value === null) return undefined;
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    }

    function normalizeRenderArgs(args: Record<string, unknown>) {
      if (typeof args.jsx !== "string") return args;
      let jsx = args.jsx
        .replace(/\{\s*["'](?:\\n|\r?\n)["']\s*\}/g, " ")
        .replace(/\\n/g, " ");
      const openFrames = jsx.match(/<Frame\b/g)?.length ?? 0;
      let closeFrames = jsx.match(/<\/Frame>/g)?.length ?? 0;
      while (closeFrames > openFrames) {
        const extraClosingTag = jsx.lastIndexOf("</Frame>");
        if (extraClosingTag < 0) break;
        jsx = `${jsx.slice(0, extraClosingTag)}${jsx.slice(extraClosingTag + "</Frame>".length)}`;
        closeFrames -= 1;
      }
      const normalized: Record<string, unknown> = jsx === args.jsx ? { ...args } : { ...args, jsx };
      if (typeof args.replace_id === "string") {
        const cardIndex = cardRootIds.indexOf(args.replace_id);
        const slot = cardSlots[cardIndex];
        if (slot) {
          if (typeof normalized.x !== "number") normalized.x = slot.x;
          if (typeof normalized.y !== "number") normalized.y = slot.y;
        }
      }
      return normalized;
    }

    const browserToolDefs = new Map<string, ToolDef>([
      ...CORE_TOOLS,
      ...ALL_TOOLS.filter((definition) => ["clone_node", "set_image_fill", "export_image"].includes(definition.name)),
    ].map((definition) => [definition.name, definition]));

    // Seed explicit card roots and a separate asset-source area. The old MVP
    // selected six arbitrary layers from one fixed template, which let the
    // model mistake those layers for six carousel cards. Every target below is
    // now a real 1080x1350 FRAME, while uploaded images live in non-target
    // source nodes that can be duplicated with OpenPencil's clone_node tool.
    const fill = (hex: string, opacity = 1) => {
      const value = hex.replace("#", "");
      return {
        type: "SOLID" as const,
        color: {
          r: Number.parseInt(value.slice(0, 2), 16) / 255,
          g: Number.parseInt(value.slice(2, 4), 16) / 255,
          b: Number.parseInt(value.slice(4, 6), 16) / 255,
          a: 1,
        },
        opacity,
        visible: true,
        blendMode: "NORMAL" as const,
      };
    };

    const rect = (name: string, x: number, y: number, width: number, height: number, color: string, radius = 0) => {
      const id = editor.createShape("RECTANGLE", x, y, width, height);
      editor.updateNode(id, { name, fills: [fill(color)], cornerRadius: radius });
      return id;
    };

    const layerIds: Record<string, string> = {};
    const cardCount = props.ideaSlides.length;
    if (cardCount === 0) {
      throw new Error("선택한 아이디어에 슬라이드 계획이 없습니다.");
    }
    const cardColumns = Math.min(3, cardCount);
    const cardGap = 120;
    const cardSlots = Array.from({ length: cardCount }, (_, index) => ({
      x: (index % cardColumns) * (1080 + cardGap),
      y: Math.floor(index / cardColumns) * (1350 + cardGap),
    }));
    const cardRootIds = Array.from({ length: cardCount }, (_, index) => {
      const slot = cardSlots[index];
      const id = editor.createShape(
        "FRAME",
        slot.x,
        slot.y,
        1080,
        1350,
      );
      editor.updateNode(id, {
        name: `CARD_ROOT_${String(index + 1).padStart(2, "0")} / EMPTY_PLACEHOLDER`,
        fills: [fill(index === 0 ? "#efe8dc" : "#f5f1ea")],
        clipsContent: true,
      });
      layerIds[`card-${index + 1}`] = id;
      return id;
    });

    const assetAreaY = Math.ceil(cardCount / cardColumns) * (1350 + cardGap) + 120;
    const assetNodeIds = props.assetItems.map((asset, index) => {
      const id = rect(
        `ASSET_SOURCE_${String(index + 1).padStart(2, "0")} / ${asset.name}`,
        (index % 4) * 380,
        assetAreaY + Math.floor(index / 4) * 320,
        340,
        260,
        "#d8d2c8",
        8,
      );
      layerIds[`asset-${index + 1}`] = id;
      return id;
    });

    function fitCardOverview(canvasElement?: HTMLCanvasElement | null) {
      if (canvasElement) {
        canvasViewportSize.width = Math.max(1, canvasElement.clientWidth);
        canvasViewportSize.height = Math.max(1, canvasElement.clientHeight);
      }
      const minX = Math.min(...cardSlots.map((slot) => slot.x));
      const minY = Math.min(...cardSlots.map((slot) => slot.y));
      const maxX = Math.max(...cardSlots.map((slot) => slot.x + 1080));
      const maxY = Math.max(...cardSlots.map((slot) => slot.y + 1350));
      editor.zoomToBounds(minX, minY, maxX, maxY);
    }

    let visibleCanvasElement: HTMLCanvasElement | null = null;
    function scheduleCardOverviewFit() {
      void nextTick().then(() => {
        requestAnimationFrame(() => fitCardOverview(visibleCanvasElement));
      });
    }

    figma.currentPage.selection = cardRootIds
      .map((id) => figma.getNodeById(id))
      .filter((node): node is NonNullable<typeof node> => node !== null);

    async function hydrateUserAssets() {
      const definition = browserToolDefs.get("set_image_fill");
      if (!definition) return;
      for (const [index, asset] of props.assetItems.entries()) {
        const target = assetNodeIds[index];
        const imageData = asset.dataUrl.includes(",") ? asset.dataUrl.slice(asset.dataUrl.indexOf(",") + 1) : asset.dataUrl;
        if (!target || !imageData) continue;
        try {
          await definition.execute(figma, { id: target, image_data: imageData, scale_mode: "FILL" });
        } catch (error) {
          pushAgentEvent("status", `${asset.name} 이미지 주입 실패`, error instanceof Error ? error.message : String(error));
        }
      }
    }

    function findCardIndexForNode(nodeId: string) {
      let current = editor.graph.getNode(nodeId);
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        const cardIndex = cardRootIds.indexOf(current.id);
        if (cardIndex >= 0) return cardIndex;
        visited.add(current.id);
        current = current.parentId ? editor.graph.getNode(current.parentId) : undefined;
      }
      return -1;
    }

    function nodeContainsImage(nodeId: string, visited = new Set<string>()): boolean {
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);
      const node = editor.graph.getNode(nodeId);
      if (!node) return false;
      if (node.fills.some((paint) => paint.type === "IMAGE" && paint.visible !== false)) return true;
      return node.childIds.some((childId) => nodeContainsImage(childId, visited));
    }

    function nodeContainsLiteralNewline(nodeId: string, visited = new Set<string>()): boolean {
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);
      const node = editor.graph.getNode(nodeId);
      if (!node) return false;
      if (node.type === "TEXT" && node.text.includes("\\n")) return true;
      return node.childIds.some((childId) => nodeContainsLiteralNewline(childId, visited));
    }

    function validateCarousel(): CarouselValidation {
      const errors: string[] = [];
      const warnings: string[] = [];
      const uniqueIds = new Set(cardRootIds);
      if (cardRootIds.length !== cardCount || uniqueIds.size !== cardCount) {
        errors.push(`Expected ${cardCount} distinct card roots, found ${uniqueIds.size}.`);
      }

      const bounds: Array<{ index: number; x: number; y: number; width: number; height: number }> = [];
      const cards = cardRootIds.map((nodeId, index) => {
        const node = editor.graph.getNode(nodeId);
        if (!node) {
          errors.push(`Card ${index + 1}: root ${nodeId} does not exist.`);
          return { index, nodeId, childCount: 0, hasImage: false };
        }

        if (node.type !== "FRAME") errors.push(`Card ${index + 1}: root must be FRAME, found ${node.type}.`);
        if (Math.abs(node.width - 1080) > 1 || Math.abs(node.height - 1350) > 1) {
          errors.push(`Card ${index + 1}: expected 1080x1350, found ${Math.round(node.width)}x${Math.round(node.height)}.`);
        }
        if (node.childIds.length === 0) errors.push(`Card ${index + 1}: contains no visual children.`);

        const hasImage = nodeContainsImage(nodeId);
        if (props.assetItems.length > 0 && !hasImage) {
          errors.push(`Card ${index + 1}: no visible user image fill was found.`);
        }
        if (nodeContainsLiteralNewline(nodeId)) {
          errors.push(`Card ${index + 1}: contains a literal \\n sequence in text.`);
        }

        bounds.push({ index, x: node.x, y: node.y, width: node.width, height: node.height });
        return {
          index,
          nodeId,
          type: node.type,
          width: node.width,
          height: node.height,
          childCount: node.childIds.length,
          hasImage,
        };
      });

      for (let first = 0; first < bounds.length; first += 1) {
        for (let second = first + 1; second < bounds.length; second += 1) {
          const a = bounds[first];
          const b = bounds[second];
          const overlaps = a.x < b.x + b.width
            && a.x + a.width > b.x
            && a.y < b.y + b.height
            && a.y + a.height > b.y;
          if (overlaps) errors.push(`Cards ${a.index + 1} and ${b.index + 1} overlap.`);
        }
      }

      if (props.assetItems.length === 0) warnings.push("No user assets were supplied, so image-fill checks were skipped.");
      return { ok: errors.length === 0, errors, warnings, cards };
    }

    async function exportNodes(ids: string[]) {
      const definition = browserToolDefs.get("export_image");
      if (!definition) throw new Error("OpenPencil export_image tool is unavailable");
      if (editor.renderer) figma.setRenderer(editor.renderer);
      const result = await definition.execute(figma, {
        ids,
        format: "PNG",
        scale: 1,
      }) as { base64?: string; mimeType?: string; error?: string };
      if (result.error) throw new Error(result.error);
      if (!result.base64) throw new Error("OpenPencil export_image returned no image data");
      return `data:${result.mimeType ?? "image/png"};base64,${result.base64}`;
    }

    async function ensureCarouselExports() {
      const images: string[] = [];
      for (const nodeId of cardRootIds) images.push(await exportNodes([nodeId]));
      exportedCardImages.value = images;
      exportedImage.value = await exportNodes([...cardRootIds]);
      return { cardImages: images, contactSheetImageUrl: exportedImage.value };
    }

    async function postBridgeResponse(requestId: string, payload: Record<string, unknown>) {
      const sessionId = agentSessionId.value;
      if (!sessionId) return;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(`/api/editor-bridge/${sessionId}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, ...payload }),
        signal: controller.signal,
      });
      window.clearTimeout(timeout);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Editor bridge response failed (${response.status})${detail ? `: ${detail}` : ""}`);
      }
    }

    async function executeAgentTool(event: MessageEvent<string>) {
      const payload = JSON.parse(event.data) as {
        request?: {
          requestId: string;
          toolName: string;
          args: Record<string, unknown>;
        };
        requestId: string;
        toolName: string;
        args: Record<string, unknown>;
      };
      // The bridge SSE envelope is { type: "tool_call", request: ... }.
      // Accepting the unwrapped shape as a fallback keeps this adapter
      // compatible with direct OpenPencil transports too.
      const request = payload.request ?? payload;

      if (mode.value === "review") {
        await postBridgeResponse(request.requestId, { error: "Editor is in review mode" });
        return;
      }

      if (request.toolName === "validate_carousel") {
        await postBridgeResponse(request.requestId, {
          result: validateCarousel(),
          graphRevision: String(Date.now()),
        });
        return;
      }

      const definition = browserToolDefs.get(request.toolName);
      if (!definition) {
        await postBridgeResponse(request.requestId, { error: `Unknown OpenPencil tool: ${request.toolName}` });
        return;
      }

      try {
        // The canvas lifecycle installs the renderer on the editor. Keeping
        // FigmaAPI pointed at the same renderer makes export_image verify the
        // exact graph the user sees.
        if (editor.renderer) figma.setRenderer(editor.renderer);
        const replacedCardIndex = request.toolName === "render" && typeof request.args.replace_id === "string"
          ? cardRootIds.indexOf(request.args.replace_id)
          : -1;
        const toolArgs = request.toolName === "render"
          ? normalizeRenderArgs(request.args)
          : request.toolName === "export_image"
            ? {
                ...request.args,
                ids: Array.isArray(request.args.ids) && request.args.ids.length > 0
                  ? request.args.ids
                  : [...cardRootIds],
              }
            : request.args;
        if (request.toolName === "reparent_node"
          && typeof toolArgs.id === "string"
          && assetNodeIds.includes(toolArgs.id)) {
          throw new Error("Asset source nodes are immutable. Call clone_node first, then reparent the clone.");
        }

        let rawResult = request.toolName === "get_selection"
          ? {
              selection: figma.currentPage.selection.map((node) => ({
                id: node.id,
                name: node.name,
                type: node.type,
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
              })),
            }
          : await definition.execute(figma, request.toolName === "get_node" && toolArgs.depth === undefined
            ? { ...toolArgs, depth: 0 }
            : toolArgs);
        if (rawResult && typeof rawResult === "object" && typeof (rawResult as { error?: unknown }).error === "string") {
          throw new Error((rawResult as { error: string }).error);
        }
        if (request.toolName === "render"
          && typeof request.args.replace_id === "string"
          && rawResult && typeof rawResult === "object"
          && typeof (rawResult as { id?: unknown }).id === "string") {
          if (replacedCardIndex >= 0) {
            const nextId = (rawResult as { id: string }).id;
            const slot = cardSlots[replacedCardIndex];
            editor.updateNode(nextId, {
              x: slot.x,
              y: slot.y,
              width: 1080,
              height: 1350,
              clipsContent: true,
            });
            cardRootIds[replacedCardIndex] = nextId;
            layerIds[`card-${replacedCardIndex + 1}`] = nextId;
          }
        }
        if (request.toolName === "clone_node"
          && typeof toolArgs.id === "string"
          && (assetNodeIds.includes(toolArgs.id) || assetCloneIds.has(toolArgs.id))
          && rawResult && typeof rawResult === "object"
          && typeof (rawResult as { id?: unknown }).id === "string") {
          assetCloneIds.add((rawResult as { id: string }).id);
        }
        if (request.toolName === "reparent_node"
          && typeof toolArgs.id === "string"
          && typeof toolArgs.parent_id === "string"
          && assetCloneIds.has(toolArgs.id)
          && findCardIndexForNode(toolArgs.parent_id) >= 0) {
          const parent = editor.graph.getNode(toolArgs.parent_id);
          if (!parent) throw new Error(`Image destination ${toolArgs.parent_id} was not found after reparenting.`);
          editor.updateNode(toolArgs.id, {
            x: 0,
            y: 0,
            width: Math.max(1, parent.width),
            height: Math.max(1, parent.height),
            visible: true,
          });
          if (parent.type === "FRAME") editor.updateNode(parent.id, { clipsContent: true });
          rawResult = {
            ...(rawResult as Record<string, unknown>),
            placement: {
              x: 0,
              y: 0,
              width: parent.width,
              height: parent.height,
              cardIndex: findCardIndexForNode(parent.id),
              imageFillPreserved: nodeContainsImage(toolArgs.id),
            },
          };
        }
        if (request.toolName === "export_image"
          && rawResult && typeof rawResult === "object"
          && typeof (rawResult as { base64?: unknown }).base64 === "string") {
          const exportResult = rawResult as { base64: string; mimeType?: string };
          const imageDataUrl = `data:${exportResult.mimeType ?? "image/png"};base64,${exportResult.base64}`;
          const exportIds = Array.isArray(toolArgs.ids) ? toolArgs.ids.filter((id): id is string => typeof id === "string") : [];
          if (exportIds.length === 1) {
            const cardIndex = cardRootIds.indexOf(exportIds[0]);
            if (cardIndex >= 0) {
              const nextImages = [...exportedCardImages.value];
              nextImages[cardIndex] = imageDataUrl;
              exportedCardImages.value = nextImages;
            }
          } else if (exportIds.length === cardRootIds.length && exportIds.every((id) => cardRootIds.includes(id))) {
            exportedImage.value = imageDataUrl;
          }
        }
        // Selection snapshots can contain full paint/text trees. Keep the
        // bridge response compact so the model can continue without waiting
        // on a huge JSON payload.
        const result = request.toolName === "get_selection" && rawResult && typeof rawResult === "object"
          ? {
              ...(rawResult as Record<string, unknown>),
              selection: Array.isArray((rawResult as { selection?: unknown }).selection)
                ? ((rawResult as { selection: Record<string, unknown>[] }).selection).map((node) => ({
                    id: node.id,
                    name: node.name,
                    type: node.type,
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                  }))
                : (rawResult as Record<string, unknown>).selection,
            }
          : rawResult;
        await postBridgeResponse(request.requestId, { result, graphRevision: String(Date.now()) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await postBridgeResponse(request.requestId, { error: message });
        } catch (responseError) {
          agentError.value = responseError instanceof Error ? responseError.message : String(responseError);
          pushAgentEvent("status", "OpenPencil tool response 실패", agentError.value);
        }
      }
    }

    async function startAgent() {
      const browserContextId = crypto.randomUUID();
      try {
        const response = await fetch(`/api/projects/${browserContextId}/editor/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          task: {
            id: browserContextId,
            request: props.task,
            target: "instagram_carousel",
            language: "ko",
            cardCount,
          },
          ideaCard: {
            id: props.ideaId,
            title: props.ideaTitle,
            hook: props.ideaHook,
            description: props.ideaDescription,
            format: props.ideaFormat,
            assets: props.ideaAssets,
            assetIds: props.ideaAssetIds,
            slides: props.ideaSlides,
          },
          assets: {
            assetSetId: browserContextId,
            items: props.assetItems.map((asset, index) => ({
              assetId: `${browserContextId}-asset-${index + 1}`,
              kind: "image",
              name: asset.name,
              url: asset.dataUrl,
              nodeId: assetNodeIds[index],
            })),
          },
          openPencil: {
            sessionId: browserContextId,
            documentId: browserContextId,
            pageId: figma.currentPageId,
            targetNodeIds: cardRootIds,
            cardRootIds,
            assetNodeIds,
            canvasWidth: 1080,
            canvasHeight: 1350,
          },
          designPrinciples: {
            rules: [
              "Keep the provided brand voice and Korean copy concise.",
              "Use the user's supplied assets before introducing substitutes.",
              "Preserve a clear hierarchy and readable contrast at 1080 × 1350.",
              props.brandText ? `Brand direction: ${props.brandText}` : "",
            ].filter(Boolean),
          },
          marketerContext: { source: "BMT idea card", ideaId: props.ideaId },
          }),
        });

        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(payload?.error ?? "Editor agent를 시작하지 못했어요");
        }

        const payload = await response.json() as { bridgeSessionId: string; traceId?: string };
        agentSessionId.value = payload.bridgeSessionId;
        agentTraceId.value = payload.traceId ?? null;
        agentStream = new EventSource(`/api/editor-bridge/${payload.bridgeSessionId}/stream`);
        agentStream.addEventListener("ready", () => {
          agentConnected.value = true;
        });
        agentStream.addEventListener("tool_call", executeAgentTool as unknown as EventListener);
        agentStream.addEventListener("agent_event", async (event) => {
          const detail = JSON.parse((event as MessageEvent<string>).data) as {
            event?: {
              type?: string;
              status?: string;
              message?: string;
              traceId?: string;
              text?: string;
              toolName?: string;
              stepId?: string;
              stepIndex?: number;
              totalSteps?: number;
              percent?: number;
              steps?: PlanStep[];
              args?: Record<string, unknown>;
              result?: unknown;
              error?: string;
              output?: AgentOutput;
            };
          };
          const agentEvent = detail.event;
          if (agentEvent?.traceId) agentTraceId.value = agentEvent.traceId;

          if (agentEvent?.type === "plan" && agentEvent.steps?.length) {
            planSteps.value = agentEvent.steps.map((step) => ({ ...step, status: "pending" }));
            currentReasoning.value = "에이전트가 편집 계획을 세웠어요.";
            pushAgentEvent("reasoning", currentReasoning.value, `${agentEvent.steps.length}개 단계`);
          }
          if (agentEvent?.type === "progress" && agentEvent.stepId && typeof agentEvent.percent === "number") {
            progress.value = Math.max(0, Math.min(100, agentEvent.percent));
            planSteps.value = planSteps.value.map((step, index) => {
              if (step.id === agentEvent.stepId) {
                return {
                  ...step,
                  status: agentEvent.status === "blocked" ? "blocked" : agentEvent.status === "completed" ? "complete" : "active",
                };
              }
              if (agentEvent.status === "started" && typeof agentEvent.stepIndex === "number" && index < agentEvent.stepIndex) {
                return { ...step, status: "complete" };
              }
              return step;
            });
            if (agentEvent.message) {
              currentReasoning.value = agentEvent.message;
              pushAgentEvent("reasoning", agentEvent.message, `진행률 ${agentEvent.percent}%`);
            }
          }
          if (agentEvent?.type === "assistant_delta" && agentEvent.text) {
            streamedAgentText.value = `${streamedAgentText.value}${agentEvent.text}`.slice(-20000);
          }
          if (agentEvent?.type === "reasoning_update" && agentEvent.message) {
            currentReasoning.value = agentEvent.message;
            pushAgentEvent("reasoning", agentEvent.message);
          }
          if (agentEvent?.type === "tool_started") {
            const toolName = agentEvent.toolName ?? "OpenPencil";
            recentTool.value = `${toolName} 실행 중`;
            pushAgentEvent("tool", toolName, readableToolDetail(agentEvent.args) ?? "실행 시작");
          }
          if (agentEvent?.type === "tool_finished") {
            const toolName = agentEvent.toolName ?? "OpenPencil";
            recentTool.value = `${toolName} 완료`;
            pushAgentEvent("tool", toolName, readableToolDetail(agentEvent.result) ?? "실행 완료");
            const result = agentEvent.result as { base64?: string; mimeType?: string } | undefined;
            if (toolName === "export_image" && result?.base64) exportedImage.value = `data:${result.mimeType ?? "image/png"};base64,${result.base64}`;
          }
          if (agentEvent?.type === "tool_failed") {
            const toolName = agentEvent.toolName ?? "OpenPencil";
            recentTool.value = `${toolName} 실패`;
            currentReasoning.value = agentEvent.error ?? `${toolName} 실행에 실패했어요.`;
            pushAgentEvent("status", toolName, agentEvent.error ?? "실행 실패");
          }
          if (agentEvent?.type === "status" && agentEvent.message && agentEvent.status !== "completed" && agentEvent.status !== "failed") {
            currentReasoning.value = agentEvent.message;
            pushAgentEvent("status", agentEvent.message, agentEvent.status);
          }
          if (agentEvent?.type === "status" && agentEvent.status === "completed" && agentEvent.output?.status === "completed") {
            finalAgentOutput.value = agentEvent.output;
            const completedRootIds = agentEvent.output.cardRoots?.map((root) => root.nodeId).filter((id): id is string => Boolean(id));
            if (completedRootIds?.length === cardCount
              && completedRootIds.every((id) => Boolean(editor.graph.getNode(id)))) {
              completedRootIds.forEach((id, index) => {
                cardRootIds[index] = id;
                layerIds[`card-${index + 1}`] = id;
              });
            }
            const validation = validateCarousel();
            if (!validation.ok) {
              agentError.value = validation.errors.join(" · ");
              currentReasoning.value = `완료 검증 실패: ${agentError.value}`;
              recentTool.value = "validate_carousel 실패";
              pushAgentEvent("status", "완료 검증 실패", agentError.value);
              progress.value = Math.min(progress.value, 99);
              return;
            }
            try {
              await ensureCarouselExports();
            } catch (error) {
              agentError.value = error instanceof Error ? error.message : String(error);
              currentReasoning.value = `최종 이미지 생성 실패: ${agentError.value}`;
              recentTool.value = "export_image 실패";
              pushAgentEvent("status", "최종 이미지 생성 실패", agentError.value);
              progress.value = Math.min(progress.value, 99);
              return;
            }
            progress.value = 100;
            planSteps.value = planSteps.value.map((step) => ({ ...step, status: "complete" }));
            currentReasoning.value = "편집 작업이 완료됐어요.";
            pushAgentEvent("status", currentReasoning.value, "completed");
          }
          if (agentEvent?.type === "status" && agentEvent.status === "needs_input") {
            const unresolved = agentEvent.output?.unresolved?.filter(Boolean).join(" · ");
            currentReasoning.value = unresolved || agentEvent.message || "추가 입력이나 편집 tool이 필요해요.";
            recentTool.value = "작업 보류";
            agentError.value = currentReasoning.value;
            progress.value = Math.min(progress.value, 99);
            planSteps.value = planSteps.value.map((step) => step.status === "active" ? { ...step, status: "blocked" } : step);
            pushAgentEvent("status", "추가 입력 필요", currentReasoning.value);
          }
          if (agentEvent?.type === "status" && agentEvent.status === "failed") {
            currentReasoning.value = agentEvent.message ?? "Editor agent 작업이 실패했어요";
            pushAgentEvent("status", currentReasoning.value, "failed");
            agentError.value = currentReasoning.value;
            progress.value = Math.min(progress.value, 99);
            planSteps.value = planSteps.value.map((step) => step.status === "active" ? { ...step, status: "blocked" } : step);
          }
        });
        agentStream.addEventListener("error", (event) => {
          agentConnected.value = false;
          const serverMessage = event instanceof MessageEvent && typeof event.data === "string"
            ? (() => {
                try {
                  const parsed = JSON.parse(event.data) as { message?: string };
                  return parsed.message;
                } catch {
                  return undefined;
                }
              })()
            : undefined;
          agentError.value = serverMessage ?? "Editor bridge 연결이 끊겼어요. 서버가 실행 중인지 확인해주세요.";
          if (serverMessage) pushAgentEvent("status", "Editor agent 실패", serverMessage);
        });
      } catch (error) {
        agentConnected.value = false;
        agentError.value = error instanceof Error && error.message
          ? error.message
          : "Editor agent에 연결하지 못했어요. 서버가 실행 중인지 확인해주세요.";
      }
    }

    provideEditor(editor);
    editor.setTool("SELECT");
    const OpenPencilCanvas = defineComponent({
      name: "OpenPencilCanvas",
      props: {
        interactive: { type: Boolean, default: false },
        autoFit: { type: Boolean, default: false },
      },
      setup(componentProps: { interactive: boolean; autoFit: boolean }) {
        const canvasRef = ref<HTMLCanvasElement | null>(null);
        const canvasSurface = useCanvas(canvasRef, editor, {
          showRulers: false,
          onReady: () => {
            if (componentProps.autoFit) {
              visibleCanvasElement = canvasRef.value;
              fitCardOverview(canvasRef.value);
            }
            resolveRendererReady?.();
            resolveRendererReady = undefined;
          },
        });
        if (componentProps.interactive) {
          useCanvasInput(
            canvasRef,
            editor,
            canvasSurface.hitTestSectionTitle,
            canvasSurface.hitTestComponentLabel,
            canvasSurface.hitTestFrameTitle,
          );
        }

        return () => h("canvas", {
          ref: (element: Element | ComponentPublicInstance | null) => {
            canvasRef.value = element as HTMLCanvasElement | null;
            if (componentProps.autoFit && canvasRef.value) visibleCanvasElement = canvasRef.value;
          },
          class: "open-pencil-surface",
          tabindex: componentProps.interactive ? "0" : "-1",
          style: { pointerEvents: componentProps.interactive ? "auto" : "none" },
          "aria-readonly": componentProps.interactive ? "false" : "true",
          "aria-label": "OpenPencil 편집 캔버스",
        });
      },
    });
    const currentTask = computed(() => planSteps.value.findIndex((step) => step.status === "active"));
    const isComplete = computed(() => progress.value >= 100);
    const availableModes = computed<Mode[]>(() => (isComplete.value ? ["auto", "review"] : ["auto", "live"]));
    watch(isComplete, (complete) => {
      if (complete && mode.value === "live") mode.value = "review";
    });

    async function finishToReview() {
      const validation = validateCarousel();
      if (!validation.ok) {
        agentError.value = validation.errors.join(" · ");
        currentReasoning.value = `최종 검증 실패: ${agentError.value}`;
        pushAgentEvent("status", "최종 검증 실패", agentError.value);
        return;
      }
      try {
        await ensureCarouselExports();
      } catch (error) {
        agentError.value = error instanceof Error ? error.message : String(error);
        currentReasoning.value = `최종 이미지 생성 실패: ${agentError.value}`;
        pushAgentEvent("status", "최종 이미지 생성 실패", agentError.value);
        return;
      }
      const output = finalAgentOutput.value;
      const slides = cardRootIds.map((nodeId, index) => {
        const metadata = output?.slides?.find((slide) => slide.nodeId === nodeId)
          ?? output?.slides?.[index];
        return {
          index,
          nodeId,
          eyebrow: `${String(index + 1).padStart(2, "0")} / ${cardCount}`,
          title: metadata?.title?.trim() || props.ideaSlides[index] || props.ideaTitle,
          copy: metadata?.copy?.trim() || (index === 0 ? props.ideaHook : props.ideaDescription),
          assetIds: metadata?.assetIds ?? output?.cardRoots?.[index]?.assetIds ?? [],
          imageDataUrl: exportedCardImages.value[index],
        };
      });
      props.onFinish({
        slides,
        caption: output?.caption?.trim() || `${props.ideaTitle}\n\n${props.ideaHook}`,
        contactSheetImageUrl: exportedImage.value ?? undefined,
        summary: output?.summary,
      });
    }

    onMounted(async () => {
      await hydrateUserAssets();
      await rendererReady;
      void startAgent();
    });

    onBeforeUnmount(() => {
      agentStream?.close();
    });

    function setMode(nextMode: Mode) {
      if (nextMode === "live" && isComplete.value) return;
      if (nextMode === "review" && !isComplete.value) return;
      mode.value = nextMode;
      if (nextMode === "live" || nextMode === "review") scheduleCardOverviewFit();
      if (agentSessionId.value) {
        void fetch(`/api/editor-bridge/${agentSessionId.value}/mode`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: nextMode }),
        }).then(async (response) => {
          if (response.ok) return;
          const payload = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(payload?.error ?? `Editor mode 변경 실패 (${response.status})`);
        }).catch((error) => {
          agentConnected.value = false;
          agentError.value = error instanceof Error && error.message
            ? error.message
            : "Editor bridge에 연결하지 못했어요. 서버가 실행 중인지 확인해주세요.";
        });
      }
    }

    function setTool(tool: Tool) {
      activeTool.value = tool;
      editor.setTool(tool);
    }

    function toolButton(tool: Tool, label: string, icon: string, interactive: boolean) {
      return h("button", {
        class: ["vue-canvas-tool", activeTool.value === tool && "active"],
        disabled: !interactive,
        title: label,
        "aria-label": label,
        onClick: () => setTool(tool),
      }, icon);
    }

    function actionButton(label: string, icon: string, handler: () => void, interactive: boolean) {
      return h("button", {
        class: "vue-canvas-action",
        disabled: !interactive,
        title: label,
        "aria-label": label,
        onClick: handler,
      }, icon);
    }

    function layerRow(id: string, label: string, kind: string) {
      return h("button", {
        class: ["vue-layer-row", selectedLayer.value === id && "selected"],
        disabled: mode.value !== "review",
        onClick: () => {
          if (mode.value !== "review") return;
          selectedLayer.value = id;
          const nodeId = layerIds[id];
          if (nodeId) editor.select([nodeId]);
        },
      }, [
        h("span", { class: `vue-layer-icon ${kind}` }, kind === "text" ? "T" : kind === "image" ? "▧" : "✦"),
        h("span", { class: "vue-layer-name" }, label),
        h("span", { class: "vue-layer-dots" }, "⋮"),
      ]);
    }

    function canvas() {
      const interactive = mode.value === "review";
      return h("div", { class: "vue-canvas-wrap" }, [
        h("div", { class: "vue-canvas-toolbar" }, [
          childText("1080 × 1350", "vue-canvas-size"),
          toolButton("SELECT", "선택", "↖", interactive),
          toolButton("FRAME", "프레임", "▱", interactive),
          toolButton("RECTANGLE", "사각형", "□", interactive),
          toolButton("TEXT", "텍스트", "T", interactive),
          h("span", { class: "vue-canvas-divider" }),
          actionButton("실행 취소", "↶", () => editor.undoAction(), interactive),
          actionButton("다시 실행", "↷", () => editor.redoAction(), interactive),
          actionButton("화면에 맞추기", "⌕", () => fitCardOverview(visibleCanvasElement), interactive),
          childText(interactive ? "Review / EDIT" : "Live / READ ONLY", "vue-canvas-zoom"),
        ]),
        h("div", { class: ["open-pencil-surface-host", !interactive && "readonly"] }, [
          h(OpenPencilCanvas, { interactive, autoFit: true }),
        ]),
      ]);
    }

    function modeTabs() {
      return h("div", { class: "vue-mode-tabs", role: "tablist", "aria-label": "편집 표시 모드" }, availableModes.value.map((item) => h("button", {
        class: ["vue-mode-tab", mode.value === item && "active"],
        role: "tab",
        "aria-selected": mode.value === item,
        onClick: () => setMode(item),
      }, [childText(modeCopy[item].label), childText(modeCopy[item].caption, "vue-mode-caption")])))
    }

    function progressList() {
      const steps = planSteps.value.length ? planSteps.value : [planningStep];
      return h("div", { class: "vue-task-list" }, steps.map((step) => {
        const status = step.status ?? "pending";
        return h("div", {
          class: ["vue-task-row", status],
        }, [
          h("span", { class: "vue-task-mark" }, status === "complete" ? "✓" : status === "active" ? "●" : status === "blocked" ? "!" : "○"),
          h("span", { class: "vue-task-copy" }, [h("strong", null, step.label), h("small", null, step.detail ?? "에이전트가 다음 작업을 준비하고 있어요.")]),
        ]);
      }));
    }

    function agentStreamView() {
      const currentStep = planSteps.value.find((step) => step.status === "active");
      return h("div", { class: "vue-agent-stream" }, [
        h("div", { class: "vue-agent-stream-heading" }, [
          h("div", { class: "vue-inspector-label" }, "AGENT STREAM"),
          agentTraceId.value ? h("small", { title: agentTraceId.value }, `TRACE ${agentTraceId.value.slice(-10)}`) : null,
        ]),
        h("div", { class: "vue-agent-run-summary" }, [
          h("div", { class: "vue-agent-run-row" }, [
            h("span", { class: "vue-agent-run-icon" }, "✦"),
            h("div", null, [h("span", { class: "vue-agent-run-label" }, "CURRENT REASONING"), h("strong", { class: "vue-agent-stream-current" }, currentReasoning.value || currentStep?.detail || "에이전트가 작업 순서를 준비하고 있어요.")]),
          ]),
          h("div", { class: "vue-agent-run-row" }, [
            h("span", { class: "vue-agent-run-icon" }, "⌁"),
            h("div", null, [h("span", { class: "vue-agent-run-label" }, "MOST RECENT TOOL"), h("strong", null, recentTool.value)]),
          ]),
        ]),
        h("details", { class: "vue-agent-event-details" }, [
          h("summary", null, [h("span", null, "전체 reasoning · tool 로그"), h("small", null, `${agentEventLog.value.length} events`)]),
          h("div", { class: "vue-agent-event-log" }, (agentEventLog.value.length ? agentEventLog.value : [{ id: "waiting", kind: "status" as const, label: "계획 수립 대기 중" }]).map((entry) => h("div", { class: ["vue-agent-event-row", entry.kind], key: entry.id }, [
            h("span", null, entry.kind === "tool" ? "TOOL" : entry.kind === "reasoning" ? "REASONING" : "STATUS"),
            h("p", null, [h("strong", null, entry.label), entry.detail ? h("small", null, entry.detail) : null]),
          ]))),
          streamedAgentText.value ? h("div", { class: "vue-agent-output-details" }, [h("div", { class: "vue-agent-run-label" }, "MODEL OUTPUT STREAM"), h("pre", null, streamedAgentText.value)]) : null,
        ]),
      ]);
    }

    function autoView() {
      return h("div", { class: "vue-auto-view" }, [
        h("div", { class: "vue-auto-hero" }, [
          h("div", { class: "vue-live-orb" }, "✦"),
          h("div", null, [h("span", { class: "vue-kicker" }, "EDITOR AGENT / AUTO MODE"), h("h2", null, "좋은 흐름을\n자동으로 만들고 있어요."), h("p", null, modeCopy.auto.description)]),
        ]),
        h("div", { class: "vue-auto-progress" }, [
          h("div", { class: "vue-progress-heading" }, [h("span", null, isComplete.value ? "편집이 완료됐어요" : "편집 중이에요"), h("strong", null, `${progress.value}%`)]),
          h("div", { class: "vue-progress-track" }, [h("span", { style: { width: `${progress.value}%` } })]),
        ]),
        progressList(),
        agentStreamView(),
        h("div", { class: "vue-auto-note" }, [h("span", null, "◎"), h("p", null, isComplete.value ? "모든 편집 작업이 끝났어요. 결과를 검토해주세요." : "편집 plane은 접혀 있어요. 작업은 계속 진행됩니다."), h("button", { onClick: () => setMode(isComplete.value ? "review" : "live") }, isComplete.value ? "Review 열기 →" : "실시간 편집 보기 →")]),
      ]);
    }

    function liveView() {
      return h("div", { class: "vue-live-view" }, [
        canvas(),
        h("aside", { class: "vue-editor-inspector" }, [
          h("div", { class: "vue-inspector-heading" }, [h("span", { class: "vue-kicker" }, "LIVE EDITING"), h("strong", null, isComplete.value ? "완료" : "작업 중")]),
          h("div", { class: "vue-live-task" }, [h("span", { class: "vue-pulse" }), h("span", null, isComplete.value ? "최종 렌더링을 확인하세요" : `${planSteps.value[currentTask.value < 0 ? 0 : currentTask.value]?.label ?? "편집 계획"}을 진행하고 있어요`)]),
          h("div", { class: "vue-live-lock-note" }, [h("span", null, "◌"), h("span", null, "에이전트 작업 중 · 캔버스 읽기 전용")]),
          agentStreamView(),
          h("div", { class: "vue-inspector-section" }, [h("div", { class: "vue-inspector-label" }, "CARD ROOTS"), ...cardRootIds.map((_, index) => layerRow(`card-${index + 1}`, `card ${String(index + 1).padStart(2, "0")}`, "shape"))]),
          h("div", { class: "vue-inspector-section" }, [h("div", { class: "vue-inspector-label" }, "ASSETS IN USE"), h("div", { class: "vue-asset-chips" }, (props.ideaAssets as string[]).map((asset) => h("span", { class: "vue-asset-chip" }, asset)))]),
          h("div", { class: "vue-live-foot" }, [h("span", null, agentConnected.value ? "OpenPencil tools connected" : agentError.value || "Agent 준비 중"), agentTraceId.value ? h("small", { title: agentTraceId.value }, `trace ${agentTraceId.value.slice(-10)}`) : null, h("button", { onClick: () => setMode("review") }, "검토 화면으로 →")]),
        ]),
      ]);
    }

    function reviewControls() {
      return h("div", { class: "vue-review-tools" }, [
        h("div", { class: "vue-inspector-label" }, "QUICK EDIT"),
        h("div", { class: "vue-review-tool-grid" }, [
          h("button", { onClick: () => editor.selectAll() }, "전체 선택"),
          h("button", { onClick: () => editor.duplicateSelected() }, "복제"),
          h("button", { onClick: () => editor.deleteSelected() }, "삭제"),
          h("button", { onClick: () => editor.nudgeSelected(-1, 0) }, "← 1px"),
          h("button", { onClick: () => editor.nudgeSelected(1, 0) }, "1px →"),
          h("button", { onClick: () => editor.nudgeSelected(0, -1) }, "↑ 1px"),
          h("button", { onClick: () => editor.nudgeSelected(0, 1) }, "↓ 1px"),
        ]),
        h("p", { class: "vue-review-tool-hint" }, "캔버스에서 요소를 선택한 뒤 드래그하거나, 도구와 단축 조작으로 미세 조정하세요."),
      ]);
    }

    function reviewView() {
      return h("div", { class: "vue-review-view" }, [
        canvas(),
        h("aside", { class: "vue-review-panel" }, [
          h("span", { class: "vue-kicker" }, "REVIEW MODE"),
          h("h2", null, isComplete.value ? "이제 당신의\n감각을 더해주세요." : "거의 다 됐어요."),
          h("p", null, isComplete.value ? modeCopy.review.description : "편집이 끝나면 이 화면에서 레이어를 직접 검토할 수 있어요."),
          h("div", { class: "vue-review-checks" }, [
            h("div", null, [h("span", null, "✓"), h("p", null, [h("strong", null, "정보 흐름"), h("small", null, "저장하고 싶은 순서로 구성됨")])]),
            h("div", null, [h("span", null, "✓"), h("p", null, [h("strong", null, "브랜드 톤"), h("small", null, "따뜻한 이미지와 짧은 문장")])]),
            h("div", null, [h("span", null, "✓"), h("p", null, [h("strong", null, "출력 규격"), h("small", null, "인스타그램 캐러셀 1080 × 1350")])]),
          ]),
          reviewControls(),
          h("button", { class: "vue-finish-button", disabled: !isComplete.value, onClick: () => void finishToReview() }, isComplete.value ? "게시물 검토로 이동 →" : "편집 완료를 기다리는 중"),
          h("button", { class: "vue-secondary-link", onClick: () => setMode("auto") }, "← 진행상황으로 돌아가기"),
        ]),
      ]);
    }

    return () => h("section", { class: "editor-plane-shell" }, [
      h("div", { class: "open-pencil-runtime-host", "aria-hidden": "true" }, [
        h(OpenPencilCanvas, { interactive: false }),
      ]),
      h("div", { class: "editor-plane-heading" }, [
        h("div", null, [h("div", { class: "vue-kicker" }, "EDITOR AGENT / 04"), h("h1", null, ["선택한 방향을 ", h("em", null, "장면으로")]), h("p", null, `${props.ideaTitle} · ${props.ideaFormat}`)]),
        h("div", { class: "editor-plane-actions" }, [h("span", { class: "vue-agent-badge" }, [h("i", null, "●"), " OPENPENCIL EDITOR"]), h("button", { class: "vue-back-link", onClick: () => (props.onBack as () => void)() }, "← 아이디어 변경")]),
      ]),
      modeTabs(),
      h("div", { class: "vue-mode-description" }, [h("span", null, modeCopy[mode.value].caption), h("p", null, modeCopy[mode.value].description)]),
      mode.value === "auto" ? autoView() : mode.value === "live" ? liveView() : reviewView(),
    ]);
  },
});

export default VueEditorPlane;
