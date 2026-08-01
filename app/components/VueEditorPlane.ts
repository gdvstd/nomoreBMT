import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import { ALL_TOOLS, CORE_TOOLS, type ToolDef } from "@open-pencil/core/tools";
import { FigmaAPI } from "@open-pencil/core/figma-api";
import { createEditor, type Tool } from "@open-pencil/core/editor";
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
  brandContext: Record<string, unknown>;
  onBack: () => void;
  onFinish: (result?: { imageDataUrl?: string }) => void;
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
    const editor = createEditor({
      getViewportSize: () => ({ width: 960, height: 620 }),
    });
    const figma = new FigmaAPI(editor.graph);
    const agentConnected = ref(false);
    const agentError = ref("");
    const agentSessionId = ref<string | null>(null);
    const agentTraceId = ref<string | null>(null);
    let agentStream: EventSource | undefined;
    const exportedImage = ref<string | null>(null);

    function pushAgentEvent(kind: AgentLogEntry["kind"], label: string, detail?: string) {
      agentEventLog.value = [{
        id: `${Date.now()}-${agentEventLog.value.length}`,
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

    const browserToolDefs = new Map<string, ToolDef>([
      ...CORE_TOOLS,
      ...ALL_TOOLS.filter((definition) => definition.name === "set_image_fill" || definition.name === "export_image"),
    ].map((definition) => [definition.name, definition]));

    // Seed a real OpenPencil document. The editor agent can replace this graph
    // with generated assets and layouts without changing the host UI contract.
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

    const text = (name: string, value: string, x: number, y: number, width: number, height: number, size: number, color: string, weight = 500) => {
      const id = editor.createShape("TEXT", x, y, width, height);
      editor.updateNode(id, {
        name,
        text: value,
        fontSize: size,
        fontFamily: "Inter",
        fontWeight: weight,
        fills: [fill(color)],
        textAutoResize: "HEIGHT",
        lineHeight: size * 0.95,
      });
      return id;
    };

    const layerIds: Record<string, string> = {};
    layerIds.background = rect("background / warm paper", 0, 0, 1080, 1350, "#efe8dc");
    layerIds["route-map"] = rect("route map / base", 60, 155, 960, 690, "#b3c3bd");
    rect("route map / river", 80, 430, 920, 34, "#d7e2d6");
    rect("route map / route", 260, 260, 520, 18, "#d86e53", 9);
    layerIds.mainPhoto = rect("main photo / crop", 150, 775, 780, 405, "#667d80", 10);
    layerIds.secondaryPhoto = rect("secondary photo / crop", 110, 610, 265, 225, "#ae7c60", 8);
    layerIds.sticker = rect("sticker / yellow", 825, 125, 120, 120, "#f8d84d", 60);
    text("eyebrow / label", "SAVE THIS ROUTE", 92, 86, 300, 38, 18, "#332e29", 700);
    layerIds.headline = text("headline / text", "강릉에서\n아무 데나\n들어가기 싫다면", 92, 255, 620, 250, 66, "#ffffff", 700);
    text("map / label", "강릉", 385, 490, 260, 70, 46, "#ffffff", 500);
    text("main photo / label", "PHOTO 01", 205, 930, 250, 44, 18, "#ffffff", 700);
    text("secondary photo / label", "PHOTO 17", 143, 700, 170, 34, 14, "#ffffff", 700);
    text("body / description", "사진 속 장소를 동선으로 엮어\n저장하고 싶은 여행 가이드로.", 96, 565, 480, 100, 22, "#332e29", 500);
    text("footer / signature", "BMT / SEYEON.STUDIO                                      01", 92, 1240, 890, 36, 15, "#332e29", 600);
    figma.currentPage.selection = Object.values(layerIds)
      .map((id) => figma.getNodeById(id))
      .filter((node): node is NonNullable<typeof node> => node !== null);

    async function hydrateUserAssets() {
      const definition = browserToolDefs.get("set_image_fill");
      if (!definition) return;
      const targets = [layerIds.mainPhoto, layerIds.secondaryPhoto];
      for (const [index, asset] of props.assetItems.entries()) {
        const target = targets[index % targets.length];
        const imageData = asset.dataUrl.includes(",") ? asset.dataUrl.slice(asset.dataUrl.indexOf(",") + 1) : asset.dataUrl;
        if (!target || !imageData) continue;
        try {
          await definition.execute(figma, { id: target, image_data: imageData, scale_mode: "FILL" });
        } catch (error) {
          pushAgentEvent("status", `${asset.name} 이미지 주입 실패`, error instanceof Error ? error.message : String(error));
        }
      }
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
        const rawResult = request.toolName === "get_selection"
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
          : await definition.execute(figma, request.toolName === "get_node" && request.args.depth === undefined
            ? { ...request.args, depth: 0 }
            : request.args);
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
            cardCount: props.ideaSlides.length || 7,
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
              nodeId: [layerIds.mainPhoto, layerIds.secondaryPhoto][index % 2],
            })),
          },
          openPencil: {
            sessionId: browserContextId,
            targetNodeIds: Object.values(layerIds),
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
        agentStream.addEventListener("agent_event", (event) => {
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
              output?: {
                status?: "completed" | "needs_input" | "failed";
                summary?: string;
                warnings?: string[];
                unresolved?: string[];
              };
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
            planSteps.value = planSteps.value.map((step) => step.status === "active" ? { ...step, status: "blocked" } : step);
            pushAgentEvent("status", "추가 입력 필요", currentReasoning.value);
          }
          if (agentEvent?.type === "status" && agentEvent.status === "failed") {
            currentReasoning.value = agentEvent.message ?? "Editor agent 작업이 실패했어요";
            pushAgentEvent("status", currentReasoning.value, "failed");
            agentError.value = currentReasoning.value;
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
      },
      setup(componentProps: { interactive: boolean }) {
        const canvasRef = ref<HTMLCanvasElement | null>(null);
        const canvasSurface = useCanvas(canvasRef, editor, {
          showRulers: false,
          onReady: () => editor.zoomToFit(),
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
      if (!exportedImage.value) {
        const definition = browserToolDefs.get("export_image");
        if (definition) {
          try {
            if (editor.renderer) figma.setRenderer(editor.renderer);
            const result = await definition.execute(figma, { format: "PNG", scale: 1 }) as { base64?: string; mimeType?: string };
            if (result.base64) exportedImage.value = `data:${result.mimeType ?? "image/png"};base64,${result.base64}`;
          } catch (error) {
            agentError.value = error instanceof Error ? error.message : String(error);
          }
        }
      }
      props.onFinish({ imageDataUrl: exportedImage.value ?? undefined });
    }

    onMounted(async () => {
      await hydrateUserAssets();
      void startAgent();
    });

    onBeforeUnmount(() => {
      agentStream?.close();
    });

    function setMode(nextMode: Mode) {
      if (nextMode === "live" && isComplete.value) return;
      if (nextMode === "review" && !isComplete.value) return;
      mode.value = nextMode;
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
          actionButton("화면에 맞추기", "⌕", () => editor.zoomToFit(), interactive),
          childText(interactive ? "Review / EDIT" : "Live / READ ONLY", "vue-canvas-zoom"),
        ]),
        h("div", { class: ["open-pencil-surface-host", !interactive && "readonly"] }, [
          h(OpenPencilCanvas, { interactive }),
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
          h("div", { class: "vue-inspector-section" }, [h("div", { class: "vue-inspector-label" }, "LAYERS"), layerRow("headline", "headline / text", "text"), layerRow("main-photo", "main photo / crop", "image"), layerRow("route-map", "route map / image", "image"), layerRow("sticker", "spark / sticker", "shape")]),
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
