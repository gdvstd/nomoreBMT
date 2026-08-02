import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from "vue";
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
import type { Idea, Reference } from "@/lib/types";
import type { SlidePlan } from "@/lib/editor-input/types";

type Mode = "auto" | "live";

type Props = {
  projectId: string;
  idea: Idea;
  references: Reference[];
  editorTraceId?: string;
  task: string;
  brandText: string;
  assetItems: { assetId: string; name: string; dataUrl: string; url?: string }[];
  brandContext: Record<string, unknown>;
  onBack: () => void;
  onFinish: (result: EditorPlaneResult) => void;
};

function slideLabel(slide: SlidePlan, index: number): string {
  const preferred = slide.text?.find(
    (item) => item.role === "title" || item.role === "hook",
  );
  return preferred?.content ?? slide.text?.[0]?.content ?? `슬라이드 ${index + 1}`;
}

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
  auto: { label: "Auto", caption: "자동 진행", description: "에이전트가 카드를 자동으로 생성합니다. 완료되면 게시물 검토로 넘어갑니다." },
  live: { label: "Live", caption: "실시간 편집", description: "사진을 자르고 배치하는 과정을 캔버스에서 실시간으로 확인해요." },
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
    projectId: { type: String, required: true },
    idea: { type: Object, required: true },
    references: { type: Array, required: false, default: () => [] },
    editorTraceId: { type: String, required: false },
    task: { type: String, required: true },
    brandText: { type: String, required: true },
    assetItems: { type: Array, required: true },
    brandContext: { type: Object, required: true },
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
    let postReviewTransitionStarted = false;

    function pushAgentEvent(kind: AgentLogEntry["kind"], label: string, detail?: string) {
      agentEventLog.value = [{
        id: `${Date.now()}-${agentEventSequence++}`,
        kind,
        label,
        detail,
      }, ...agentEventLog.value].slice(0, 300);
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
        .replace(/\\n/g, " ")
        // OpenPencil <Text> uses size=/color=/weight=. Models frequently emit
        // unsupported aliases (e.g. textSize) that are silently ignored, which
        // leaves every text node at the 14px default. Translate the confirmed
        // aliases to supported props before rendering.
        .replace(/\btextSize=/g, "size=")
        .replace(/\bfont_size=/g, "fontSize=")
        .replace(/\b(?:textColor|fontColor)=/g, "color=")
        .replace(/\btextWeight=/g, "weight=");
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
    const cardCount = props.idea.slides.length;
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

    function collectImageFillHashes(
      nodeId: string,
      visited = new Set<string>(),
    ): string[] {
      if (visited.has(nodeId)) return [];
      visited.add(nodeId);
      const node = editor.graph.getNode(nodeId);
      if (!node) return [];
      const ownHashes = node.fills
        .filter((paint) => paint.type === "IMAGE" && paint.visible !== false)
        .map((paint) => paint.imageHash || "__IMAGE_WITHOUT_HASH__");
      return [
        ...ownHashes,
        ...node.childIds.flatMap((childId) =>
          collectImageFillHashes(childId, visited),
        ),
      ];
    }

    function collectImageNodeIds(
      nodeId: string,
      visited = new Set<string>(),
    ): string[] {
      if (visited.has(nodeId)) return [];
      visited.add(nodeId);
      const node = editor.graph.getNode(nodeId);
      if (!node) return [];
      const ownIds = node.fills.some(
        (paint) => paint.type === "IMAGE" && paint.visible !== false,
      ) ? [node.id] : [];
      return [
        ...ownIds,
        ...node.childIds.flatMap((childId) =>
          collectImageNodeIds(childId, visited),
        ),
      ];
    }

    function collectVisibleTextNodeIds(
      nodeId: string,
      visited = new Set<string>(),
    ): string[] {
      if (visited.has(nodeId)) return [];
      visited.add(nodeId);
      const node = editor.graph.getNode(nodeId);
      if (!node || node.visible === false) return [];
      const ownIds = node.type === "TEXT" && node.text.trim() ? [node.id] : [];
      return [
        ...ownIds,
        ...node.childIds.flatMap((childId) =>
          collectVisibleTextNodeIds(childId, visited),
        ),
      ];
    }

    function pathFromCard(cardId: string, nodeId: string) {
      const reversed: string[] = [];
      let current = editor.graph.getNode(nodeId);
      const visited = new Set<string>();
      while (current && !visited.has(current.id)) {
        reversed.push(current.id);
        if (current.id === cardId) return reversed.reverse();
        visited.add(current.id);
        current = current.parentId
          ? editor.graph.getNode(current.parentId)
          : undefined;
      }
      return [];
    }

    function textReadabilityErrors(cardId: string, textNodeId: string) {
      const errors: string[] = [];
      const path = pathFromCard(cardId, textNodeId);
      const textNode = editor.graph.getNode(textNodeId);
      const cardBounds = editor.graph.getAbsoluteBounds(cardId);
      const textBounds = editor.graph.getAbsoluteBounds(textNodeId);
      if (!textNode || path.length === 0) return [`text ${textNodeId} is detached from its card.`];

      let effectiveOpacity = 1;
      for (const pathId of path) {
        const pathNode = editor.graph.getNode(pathId);
        if (!pathNode) continue;
        effectiveOpacity *= pathNode.opacity;
        if (pathNode.id !== cardId && pathNode.id !== textNodeId && pathNode.clipsContent) {
          const ancestorBounds = editor.graph.getAbsoluteBounds(pathNode.id);
          const clipped = textBounds.x < ancestorBounds.x
            || textBounds.y < ancestorBounds.y
            || textBounds.x + textBounds.width > ancestorBounds.x + ancestorBounds.width
            || textBounds.y + textBounds.height > ancestorBounds.y + ancestorBounds.height;
          if (clipped) errors.push(`text ${textNodeId} is clipped by ancestor ${pathNode.id}.`);
        }
      }
      if (effectiveOpacity < 0.9) {
        errors.push(`text ${textNodeId} effective opacity is ${effectiveOpacity.toFixed(2)}; text and all text parents must remain opaque.`);
      }

      const safeMargin = 48;
      const violatesSafeArea = textBounds.x < cardBounds.x + safeMargin
        || textBounds.y < cardBounds.y + safeMargin
        || textBounds.x + textBounds.width > cardBounds.x + cardBounds.width - safeMargin
        || textBounds.y + textBounds.height > cardBounds.y + cardBounds.height - safeMargin;
      if (violatesSafeArea) errors.push(`text ${textNodeId} violates the ${safeMargin}px card safe area.`);
      return errors;
    }

    function imagePaintsBelowText(
      cardId: string,
      imageNodeId: string,
      textNodeId: string,
    ) {
      const imagePath = pathFromCard(cardId, imageNodeId);
      const textPath = pathFromCard(cardId, textNodeId);
      if (!imagePath.length || !textPath.length) return false;
      let divergence = 0;
      while (
        divergence < imagePath.length
        && divergence < textPath.length
        && imagePath[divergence] === textPath[divergence]
      ) divergence += 1;
      if (divergence === imagePath.length) return true;
      if (divergence === textPath.length) return false;
      const commonParent = editor.graph.getNode(imagePath[divergence - 1]);
      if (!commonParent) return false;
      return commonParent.childIds.indexOf(imagePath[divergence])
        < commonParent.childIds.indexOf(textPath[divergence]);
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

        const imageHashes = collectImageFillHashes(nodeId);
        const imageNodeIds = collectImageNodeIds(nodeId);
        const textNodeIds = collectVisibleTextNodeIds(nodeId);
        const hasImage = imageHashes.length > 0;
        if (imageHashes.length !== 1) {
          errors.push(`Card ${index + 1}: expected exactly one visible user image fill, found ${imageHashes.length}.`);
        }
        const expectedAssetId = props.idea.slides[index]?.sourceAssetId;
        const expectedAssetIndex = props.assetItems.findIndex(
          (asset) => asset.assetId === expectedAssetId,
        );
        if (expectedAssetIndex < 0) {
          errors.push(`Card ${index + 1}: source asset ${expectedAssetId ?? "missing"} is unavailable.`);
        }
        const expectedAssetNodeId = assetNodeIds[expectedAssetIndex];
        const expectedImageHash = expectedAssetNodeId
          ? collectImageFillHashes(expectedAssetNodeId)[0]
          : undefined;
        if (
          expectedImageHash &&
          imageHashes.length === 1 &&
          imageHashes[0] !== expectedImageHash
        ) {
          errors.push(`Card ${index + 1}: image does not match source asset ${expectedAssetId}.`);
        }
        if (nodeContainsLiteralNewline(nodeId)) {
          errors.push(`Card ${index + 1}: contains a literal \\n sequence in text.`);
        }
        const expectedTextCount = props.idea.slides[index]?.text?.length ?? 0;
        if (textNodeIds.length < expectedTextCount) {
          errors.push(
            `Card ${index + 1}: expected at least ${expectedTextCount} visible text layers, found ${textNodeIds.length}.`,
          );
        }
        for (const imageNodeId of imageNodeIds) {
          for (const textNodeId of textNodeIds) {
            if (!imagePaintsBelowText(nodeId, imageNodeId, textNodeId)) {
              errors.push(
                `Card ${index + 1}: image layer ${imageNodeId} paints above text ${textNodeId}. Move the image below all text layers.`,
              );
              break;
            }
          }
        }
        const cardBounds = editor.graph.getAbsoluteBounds(nodeId);
        const expectsFullBleed =
          props.idea.slides[index]?.imageTreatment === "full_bleed";
        if (expectsFullBleed && imageNodeIds.length > 0) {
          const coversCard = imageNodeIds.some((imageNodeId) => {
            const imageBounds = editor.graph.getAbsoluteBounds(imageNodeId);
            const widthRatio = imageBounds.width / Math.max(1, cardBounds.width);
            const heightRatio = imageBounds.height / Math.max(1, cardBounds.height);
            return widthRatio >= 0.98
              && heightRatio >= 0.98
              && imageBounds.x <= cardBounds.x + 2
              && imageBounds.y <= cardBounds.y + 2
              && imageBounds.x + imageBounds.width >= cardBounds.x + cardBounds.width - 2
              && imageBounds.y + imageBounds.height >= cardBounds.y + cardBounds.height - 2;
          });
          if (!coversCard) {
            errors.push(
              `Card ${index + 1}: EditorInput requires full-bleed, but no image reaches all four edges. Resize/move IMAGE_SLOT and IMAGE_LAYER to x=0, y=0, 1080x1350.`,
            );
          }
        }
        for (const textNodeId of textNodeIds) {
          const textBounds = editor.graph.getAbsoluteBounds(textNodeId);
          const outside = textBounds.x < cardBounds.x
            || textBounds.y < cardBounds.y
            || textBounds.x + textBounds.width > cardBounds.x + cardBounds.width
            || textBounds.y + textBounds.height > cardBounds.y + cardBounds.height;
          if (outside) {
            errors.push(`Card ${index + 1}: text ${textNodeId} extends outside the card.`);
          }
          for (const readabilityError of textReadabilityErrors(nodeId, textNodeId)) {
            errors.push(`Card ${index + 1}: ${readabilityError}`);
          }
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
          imageCount: imageHashes.length,
          expectedAssetId,
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

    // Deterministic self-healing for the two invariants the model repeatedly
    // fails: every card must contain its assigned user image, and no text
    // parent may be translucent. Both are known from the slide plan, so we fix
    // them from the browser rather than looping the agent.
    async function ensureCardImages() {
      const cloneDef = browserToolDefs.get("clone_node");
      const reparentDef = browserToolDefs.get("reparent_node");
      if (!cloneDef || !reparentDef) return;
      for (let index = 0; index < cardRootIds.length; index += 1) {
        const cardId = cardRootIds[index];
        if (nodeContainsImage(cardId)) continue;
        const expectedAssetId = props.idea.slides[index]?.sourceAssetId;
        const assetIndex = props.assetItems.findIndex(
          (asset) => asset.assetId === expectedAssetId,
        );
        const assetNodeId = assetIndex >= 0 ? assetNodeIds[assetIndex] : undefined;
        if (!assetNodeId) continue;
        try {
          const clone = (await cloneDef.execute(figma, { id: assetNodeId })) as {
            id?: string;
            error?: string;
          };
          const cloneId = clone?.id;
          if (!cloneId) continue;
          assetCloneIds.add(cloneId);
          const card = editor.graph.getNode(cardId);
          const slot = card?.childIds
            .map((childId) => editor.graph.getNode(childId))
            .find((node) => node?.name?.includes("IMAGE_SLOT"));
          const destId = slot?.id ?? cardId;
          await reparentDef.execute(figma, { id: cloneId, parent_id: destId });
          const dest = editor.graph.getNode(destId);
          if (dest) {
            editor.updateNode(cloneId, {
              x: 0,
              y: 0,
              width: Math.max(1, dest.width),
              height: Math.max(1, dest.height),
              visible: true,
            });
            if (dest.type === "FRAME") editor.updateNode(dest.id, { clipsContent: true });
            editor.graph.reorderChild(cloneId, dest.id, 0);
          }
          pushAgentEvent("tool", `카드 ${index + 1} 이미지 자동 배치`, `assetId=${expectedAssetId}`);
        } catch (error) {
          pushAgentEvent(
            "status",
            `카드 ${index + 1} 이미지 자동 배치 실패`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }

    function enforceTextParentOpacity() {
      for (const cardId of cardRootIds) {
        for (const textId of collectVisibleTextNodeIds(cardId)) {
          let current = editor.graph.getNode(textId);
          const visited = new Set<string>();
          while (current && !visited.has(current.id)) {
            if (current.opacity < 1) editor.updateNode(current.id, { opacity: 1 });
            if (current.id === cardId) break;
            visited.add(current.id);
            current = current.parentId ? editor.graph.getNode(current.parentId) : undefined;
          }
        }
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

      if (request.toolName === "validate_carousel") {
        await ensureCardImages();
        enforceTextParentOpacity();
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
          // OpenPencil appendChild makes the newly reparented image frontmost.
          // Keep an asset clone at the back of its destination so it cannot
          // cover overlay and text siblings even when a model chooses the card
          // root instead of the recommended IMAGE_SLOT.
          editor.graph.reorderChild(toolArgs.id, parent.id, 0);
          rawResult = {
            ...(rawResult as Record<string, unknown>),
            placement: {
              x: 0,
              y: 0,
              width: parent.width,
              height: parent.height,
              cardIndex: findCardIndexForNode(parent.id),
              imageFillPreserved: nodeContainsImage(toolArgs.id),
              paintOrder: "backmost-child",
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
        const response = await fetch(`/api/projects/${props.projectId}/editor/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          idea: props.idea,
          references: props.references,
          task: {
            id: props.projectId,
            request: props.task,
            target: "instagram_carousel",
            language: "ko",
            cardCount: props.idea.slides.length,
          },
          assets: {
            assetSetId: props.projectId,
            items: props.assetItems.map((asset, index) => ({
              assetId: asset.assetId,
              kind: "image",
              name: asset.name,
              url: asset.url ?? asset.dataUrl,
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
          brandContext: props.brandContext,
          marketerContext: { source: "BMT idea card", ideaId: props.idea.id },
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
            currentReasoning.value = "최종 이미지를 준비하고 게시물 검토로 이동하고 있어요.";
            recentTool.value = "최종 검증 · export_image";
            progress.value = Math.max(progress.value, 99);
            pushAgentEvent("status", currentReasoning.value, "transitioning");
            await finishToPostReview();
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
    const availableModes = computed<Mode[]>(() => ["auto", "live"]);

    async function finishToPostReview() {
      if (postReviewTransitionStarted) return;
      postReviewTransitionStarted = true;
      await ensureCardImages();
      enforceTextParentOpacity();
      const validation = validateCarousel();
      if (!validation.ok) {
        agentError.value = validation.errors.join(" · ");
        currentReasoning.value = `최종 검증 실패: ${agentError.value}`;
        pushAgentEvent("status", "최종 검증 실패", agentError.value);
        progress.value = Math.min(progress.value, 99);
        postReviewTransitionStarted = false;
        return;
      }
      try {
        await ensureCarouselExports();
      } catch (error) {
        agentError.value = error instanceof Error ? error.message : String(error);
        currentReasoning.value = `최종 이미지 생성 실패: ${agentError.value}`;
        pushAgentEvent("status", "최종 이미지 생성 실패", agentError.value);
        progress.value = Math.min(progress.value, 99);
        postReviewTransitionStarted = false;
        return;
      }
      progress.value = 100;
      planSteps.value = planSteps.value.map((step) => ({ ...step, status: "complete" }));
      currentReasoning.value = "편집이 완료되어 게시물 검토로 이동합니다.";
      pushAgentEvent("status", currentReasoning.value, "completed");
      const output = finalAgentOutput.value;
      const slides = cardRootIds.map((nodeId, index) => {
        const metadata = output?.slides?.find((slide) => slide.nodeId === nodeId)
          ?? output?.slides?.[index];
        return {
          index,
          nodeId,
          eyebrow: `${String(index + 1).padStart(2, "0")} / ${cardCount}`,
          title: metadata?.title?.trim() || slideLabel(props.idea.slides[index], index) || props.idea.title,
          copy: metadata?.copy?.trim() || (index === 0 ? props.idea.hook : props.idea.description),
          assetIds: metadata?.assetIds ?? output?.cardRoots?.[index]?.assetIds ?? [],
          imageDataUrl: exportedCardImages.value[index],
        };
      });
      props.onFinish({
        slides,
        caption: output?.caption?.trim() || `${props.idea.title}\n\n${props.idea.hook}`,
        contactSheetImageUrl: exportedImage.value ?? undefined,
        summary: output?.summary,
        diagnostics: {
          editorTraceId: agentTraceId.value ?? undefined,
          selectedIdea: props.idea,
          eventLog: agentEventLog.value.map(({ kind, label, detail }) => ({
            kind,
            label,
            detail,
          })),
          finalOutput: output,
        },
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
      mode.value = nextMode;
      if (nextMode === "live") scheduleCardOverviewFit();
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
        disabled: true,
      }, [
        h("span", { class: `vue-layer-icon ${kind}` }, kind === "text" ? "T" : kind === "image" ? "▧" : "✦"),
        h("span", { class: "vue-layer-name" }, label),
        h("span", { class: "vue-layer-dots" }, "⋮"),
      ]);
    }

    function canvas() {
      const interactive = false;
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
          childText("Live / READ ONLY", "vue-canvas-zoom"),
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

    function editorInputView() {
      const referenceById = new Map(
        props.references.map((reference) => [reference.id, reference]),
      );
      return h("details", { class: "vue-editor-input-details" }, [
        h("summary", null, [
          h("span", null, [
            h("strong", null, "SLIDE PLAN"),
            h("small", null, `${cardCount} slides · 마케터 설계`),
          ]),
          h("span", null, "설계 근거 보기 +"),
        ]),
        h("div", { class: "vue-editor-input-body" }, [
          h("p", { class: "vue-editor-input-design" }, props.idea.designDirection),
          props.idea.referenceIds.length
            ? h("div", { class: "vue-editor-input-refs" }, props.idea.referenceIds.map((referenceId) => {
                const reference = referenceById.get(referenceId);
                if (!reference) return null;
                return h("a", {
                  class: "vue-editor-input-ref-chip",
                  href: reference.instagramUrl,
                  target: "_blank",
                  rel: "noreferrer",
                }, [
                  reference.previewImageUrl
                    ? h("img", { src: reference.previewImageUrl, alt: "레퍼런스 미리보기", loading: "lazy" })
                    : null,
                  h("span", null, reference.creatorHandle ? `@${reference.creatorHandle}` : "레퍼런스"),
                ]);
              }))
            : null,
          h("div", { class: "vue-editor-input-slides" }, props.idea.slides.map((slide, index) => h("div", { class: "vue-editor-input-slide" }, [
            h("span", null, String(index + 1).padStart(2, "0")),
            h("div", null, [
              h("strong", null, slideLabel(slide, index)),
              h("p", { class: "vue-editor-input-intent" }, slide.intent),
              h("p", { class: "vue-editor-input-imageintent" }, slide.imageIntent),
              h("small", null, `${slide.sourceAssetId} · ${slide.imageTreatment} · ${slide.text?.length ?? 0} text layers`),
              slide.referenceInspirations.length
                ? h("ul", { class: "vue-editor-input-inspirations" }, slide.referenceInspirations.map((inspiration) => {
                    const reference = referenceById.get(inspiration.referenceId);
                    return h("li", null, [
                      h("strong", null, reference?.creatorHandle ? `@${reference.creatorHandle}` : "레퍼런스"),
                      h("span", null, ` ${inspiration.borrowed} → ${inspiration.adaptedHow}`),
                    ]);
                  }))
                : null,
            ]),
          ]))),
          h("details", { class: "vue-editor-input-raw" }, [
            h("summary", null, "원본 슬라이드 플랜 JSON"),
            h("pre", null, JSON.stringify(props.idea.slides, null, 2)),
          ]),
        ]),
      ]);
    }

    function autoView() {
      return h("div", { class: "vue-auto-view" }, [
        h("div", { class: "vue-auto-hero" }, [
          h("div", { class: "vue-live-orb" }, "✦"),
          h("div", null, [h("span", { class: "vue-kicker" }, "AUTO LAYOUT"), h("h2", null, "카드를 생성하는 중"), h("p", null, modeCopy.auto.description)]),
        ]),
        h("div", { class: "vue-auto-progress" }, [
          h("div", { class: "vue-progress-heading" }, [h("span", null, isComplete.value ? "편집이 완료됐어요" : "편집 중이에요"), h("strong", null, `${progress.value}%`)]),
          h("div", { class: "vue-progress-track" }, [h("span", { style: { width: `${progress.value}%` } })]),
        ]),
        progressList(),
        editorInputView(),
        agentStreamView(),
        h("div", { class: "vue-auto-note" }, [h("span", null, "◎"), h("p", null, isComplete.value ? "게시물 검토 화면으로 이동하고 있어요." : "편집 plane은 접혀 있어요. 작업은 계속 진행됩니다."), isComplete.value ? null : h("button", { onClick: () => setMode("live") }, "실시간 편집 보기 →")]),
      ]);
    }

    function liveView() {
      return h("div", { class: "vue-live-view" }, [
        canvas(),
        h("aside", { class: "vue-editor-inspector" }, [
          h("div", { class: "vue-inspector-heading" }, [h("span", { class: "vue-kicker" }, "LIVE EDITING"), h("strong", null, isComplete.value ? "완료" : "작업 중")]),
          h("div", { class: "vue-live-task" }, [h("span", { class: "vue-pulse" }), h("span", null, isComplete.value ? "최종 렌더링을 확인하세요" : `${planSteps.value[currentTask.value < 0 ? 0 : currentTask.value]?.label ?? "편집 계획"}을 진행하고 있어요`)]),
          h("div", { class: "vue-live-lock-note" }, [h("span", null, "◌"), h("span", null, "에이전트 작업 중 · 캔버스 읽기 전용")]),
          editorInputView(),
          agentStreamView(),
          h("div", { class: "vue-inspector-section" }, [h("div", { class: "vue-inspector-label" }, "CARD ROOTS"), ...cardRootIds.map((_, index) => layerRow(`card-${index + 1}`, `card ${String(index + 1).padStart(2, "0")}`, "shape"))]),
          h("div", { class: "vue-inspector-section" }, [h("div", { class: "vue-inspector-label" }, "ASSETS IN USE"), h("div", { class: "vue-asset-chips" }, props.idea.assets.map((asset) => h("span", { class: "vue-asset-chip" }, asset)))]),
          h("div", { class: "vue-live-foot" }, [h("span", null, agentConnected.value ? "완료되면 게시물 검토로 자동 이동합니다" : agentError.value || "편집 준비 중"), h("button", { onClick: () => setMode("auto") }, "진행상황 보기 →")]),
        ]),
      ]);
    }

    return () => h("section", { class: "editor-plane-shell" }, [
      h("div", { class: "open-pencil-runtime-host", "aria-hidden": "true" }, [
        h(OpenPencilCanvas, { interactive: false }),
      ]),
      h("div", { class: "editor-plane-heading" }, [
        h("div", null, [h("h1", null, ["카드 ", h("em", null, "편집")])]),
      ]),
      modeTabs(),
      h("div", { class: "vue-mode-description" }, [h("span", null, modeCopy[mode.value].caption), h("p", null, modeCopy[mode.value].description)]),
      mode.value === "auto" ? autoView() : liveView(),
      h("div", { class: "editor-plane-footer-actions" }, [h("button", { class: "vue-back-link", onClick: () => (props.onBack as () => void)() }, "← 아이디어 변경")]),
    ]);
  },
});

export default VueEditorPlane;
