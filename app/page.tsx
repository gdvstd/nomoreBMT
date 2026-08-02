"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { User } from "@supabase/supabase-js";
import { AuthScreen } from "@/app/components/AuthScreen";
import {
  brandContextSchema,
  brandContextToAgentText,
  EMPTY_ONBOARDING_ANSWERS,
  normalizeInstagramHandle,
  type BrandContext,
  type OnboardingAnswers,
} from "@/lib/onboarding/types";
import {
  loadOnboardingProfile,
  saveOnboardingProfile,
  type OnboardingStorageResult,
} from "@/lib/onboarding/storage";
import {
  uploadRenderedProjectAssets,
  uploadUserProjectAssets,
} from "@/lib/project-assets/browser";
import type { ProjectAsset } from "@/lib/project-assets/types";
import { getSupabaseBrowserClient } from "@/lib/supabase";
import type { ComplianceCheck, EditorPlaneResult, Idea, Reference, RenderedPost, Screen } from "@/lib/types";

type UploadedAsset = {
  id: string;
  name: string;
  previewUrl: string;
  description: string;
  dataUrl: string;
  file: File;
};

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_USER_PHOTOS = 9;


type AgentLogEntry = {
  id: string;
  kind: "reasoning" | "skill" | "tool" | "status";
  label: string;
  detail?: string;
};

const EditorPlaneMount = dynamic(() => import("@/app/components/EditorPlaneMount"), {
  ssr: false,
  loading: () => <div className="vue-editor-mount" aria-label="편집기를 불러오는 중" />,
});

const steps: { id: Screen; label: string; number: string }[] = [
  { id: "onboarding", label: "브랜드 방향", number: "01" },
  { id: "brief", label: "콘텐츠 요청", number: "02" },
  { id: "ideas", label: "아이디어 선택", number: "03" },
  { id: "editor", label: "편집 과정", number: "04" },
  { id: "review", label: "게시물 검토", number: "05" },
];

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했어요"));
    reader.readAsDataURL(file);
  });
}

export default function Home() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>(() => {
    if (typeof window === "undefined") return "onboarding";
    const saved = window.sessionStorage.getItem("nomorebmt-screen");
    return steps.some((step) => step.id === saved) ? saved as Screen : "onboarding";
  });
  const [onboardingAnswers, setOnboardingAnswers] = useState<OnboardingAnswers>({ ...EMPTY_ONBOARDING_ANSWERS });
  const [brandContext, setBrandContext] = useState<BrandContext | null>(null);
  const [storageMode, setStorageMode] = useState<OnboardingStorageResult["storage"] | null>(null);
  const [brief, setBrief] = useState("");
  const [files, setFiles] = useState<UploadedAsset[]>([]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [ideasError, setIdeasError] = useState("");
  const [fileError, setFileError] = useState("");
  const [ideasCurrentReasoning, setIdeasCurrentReasoning] = useState("마케팅 agent 실행을 준비하고 있어요.");
  const [ideasRecentSkill, setIdeasRecentSkill] = useState("사용 대기 중");
  const [ideasRecentTool, setIdeasRecentTool] = useState("호출 대기 중");
  const [ideasEventLog, setIdeasEventLog] = useState<AgentLogEntry[]>([]);
  const [ideasStreamText, setIdeasStreamText] = useState("");
  const [ideasTraceId, setIdeasTraceId] = useState("");
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [storedUserAssets, setStoredUserAssets] = useState<ProjectAsset[]>([]);
  /** Marketer-authored references (provenance + editor design evidence). */
  const [references, setReferences] = useState<Reference[]>([]);
  /** Server-computed proof the marketer followed its assigned procedure. */
  const [marketerCompliance, setMarketerCompliance] = useState<ComplianceCheck[]>([]);
  const [editorInputLoading, setEditorInputLoading] = useState(false);
  const [editorInputStatus, setEditorInputStatus] = useState("선택한 방향을 편집 지시로 바꿀 준비가 됐어요.");
  const [renderedPost, setRenderedPost] = useState<RenderedPost | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const marketerStream = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!supabase) {
      setAuthLoading(false);
      return;
    }

    let active = true;
    const loadingTimeout = window.setTimeout(() => {
      if (!active) return;
      setAuthUser(null);
      setAuthLoading(false);
    }, 8000);

    void supabase.auth.getUser()
      .then(({ data }) => {
        if (!active) return;
        setAuthUser(data.user);
        setAuthLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setAuthUser(null);
        setAuthLoading(false);
      })
      .finally(() => window.clearTimeout(loadingTimeout));

    const { data: authState } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user ?? null);
      setAuthLoading(false);
    });

    return () => {
      active = false;
      window.clearTimeout(loadingTimeout);
      authState.subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => () => {
    marketerStream.current?.close();
  }, []);

  useEffect(() => {
    window.sessionStorage.setItem("nomorebmt-screen", screen);
  }, [screen]);

  const brandText = useMemo(() => brandContextToAgentText(brandContext), [brandContext]);
  // Stable identities for the editor plane props. Without memoization these
  // arrays are recreated every render, so any parent re-render would remount
  // the Vue editor and restart the running agent back to 0%.
  const editorAssetItems = useMemo(
    () => files.map((file) => ({
      assetId: file.id,
      name: file.name,
      dataUrl: file.dataUrl,
      url: storedUserAssets.find((asset) => asset.assetId === file.id)?.signedUrl,
    })),
    [files, storedUserAssets],
  );
  const editorReferences = useMemo(
    () => (selectedIdea
      ? references.filter((reference) => selectedIdea.referenceIds.includes(reference.id))
      : []),
    [references, selectedIdea],
  );
  const currentStep = steps.findIndex((step) => step.id === screen);
  const profileSummary = useMemo(() => {
    if (!brandContext) return "아직 브랜드 방향을 입력하지 않았어요";
    return brandContext.brandSummary.length > 52
      ? `${brandContext.brandSummary.slice(0, 52)}…`
      : brandContext.brandSummary;
  }, [brandContext]);

  useEffect(() => {
    if (authLoading || !authUser) return;

    let active = true;
    const savedScreen = window.sessionStorage.getItem("nomorebmt-screen");
    const rememberedScreen = savedScreen && steps.some((step) => step.id === savedScreen)
      ? savedScreen as Screen
      : "onboarding";

    setScreen(rememberedScreen);
    setOnboardingAnswers({ ...EMPTY_ONBOARDING_ANSWERS });
    setBrandContext(null);
    setStorageMode(null);

    void loadOnboardingProfile().then((saved) => {
      if (!active || !saved) return;
      setOnboardingAnswers(saved.profile.answers);
      setBrandContext(saved.profile.context);
      setStorageMode(saved.storage);
      setScreen(rememberedScreen === "onboarding" ? "dashboard" : rememberedScreen);
    });

    return () => {
      active = false;
    };
  }, [authLoading, authUser?.id]);

  async function completeOnboarding(answers: OnboardingAnswers) {
    const normalizedAnswers = {
      ...answers,
      instagramHandle: normalizeInstagramHandle(answers.instagramHandle),
    };
    const response = await fetch("/api/onboarding/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalizedAnswers),
    });
    const payload = await response.json() as { context?: unknown; error?: string };
    if (!response.ok || !payload.context) {
      throw new Error(payload.error ?? "브랜드 컨텍스트를 만들지 못했어요");
    }

    const context = brandContextSchema.parse(payload.context);
    const saved = await saveOnboardingProfile({
      answers: normalizedAnswers,
      context,
      updatedAt: new Date().toISOString(),
    });
    setOnboardingAnswers(normalizedAnswers);
    setBrandContext(context);
    setStorageMode(saved.storage);
    setScreen("dashboard");
    return saved;
  }

  async function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(event.target.files ?? []);
    const invalidFormat = incoming.filter((file) => {
      const lowerName = file.name.toLowerCase();
      return !ALLOWED_IMAGE_TYPES.has(file.type) || !ALLOWED_IMAGE_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
    });
    const oversized = incoming.filter((file) => file.size > MAX_IMAGE_SIZE);
    const valid = incoming.filter((file) => !invalidFormat.includes(file) && !oversized.includes(file));
    const remainingSlots = Math.max(0, MAX_USER_PHOTOS - files.length);
    const accepted = valid.slice(0, remainingSlots);

    if (invalidFormat.length > 0) {
      setFileError("JPG, JPEG, PNG, WEBP 형식의 이미지만 올릴 수 있어요.");
    } else if (oversized.length > 0) {
      setFileError("이미지 한 장의 크기는 10MB 이하여야 해요.");
    } else if (valid.length > remainingSlots) {
      setFileError(`사진은 최대 ${MAX_USER_PHOTOS}장까지 올릴 수 있어요.`);
    } else {
      setFileError("");
    }

    const selected = await Promise.all(accepted.map(async (file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      dataUrl: await readFileAsDataUrl(file),
      file,
      description: "",
    })));
    setFiles((previous) => {
      const combined = [...previous, ...selected];
      combined.slice(MAX_USER_PHOTOS).forEach((file) => URL.revokeObjectURL(file.previewUrl));
      return combined.slice(0, MAX_USER_PHOTOS);
    });
    event.target.value = "";
  }

  function removeFile(index: number) {
    setFiles((previous) => {
      URL.revokeObjectURL(previous[index].previewUrl);
      return previous.filter((_, fileIndex) => fileIndex !== index);
    });
  }

  function updateFileDescription(index: number, description: string) {
    setFiles((previous) => previous.map((file, fileIndex) => (
      fileIndex === index ? { ...file, description } : file
    )));
  }

  function reorderFiles(fromIndex: number, toIndex: number) {
    setFiles((previous) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= previous.length || toIndex >= previous.length) return previous;
      const next = [...previous];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  function chooseIdea(idea: Idea) {
    setSelectedIdea(idea);
    setRenderedPost(null);
    setEditorInputStatus("선택한 방향을 편집 화면으로 넘길 준비가 됐어요.");
  }

  async function createPost() {
    if (!selectedIdea) return;
    if (!activeProjectId || !storedUserAssets.length) {
      setIdeasError(
        "업로드한 사진의 저장 정보가 없습니다. 요청 수정으로 돌아가 아이디어를 다시 생성해주세요.",
      );
      return;
    }
    // The marketer already authored a complete slide plan per idea, so there is
    // no separate EditorInput planner call. Hand the selected plan straight to
    // the editor plane.
    setIdeasError("");
    setEditorInputStatus("선택한 슬라이드 플랜을 편집 화면으로 전달하고 있어요.");
    setRenderedPost(null);
    setActiveSlide(0);
    setScreen("editor");
  }

  async function generateIdeas() {
    marketerStream.current?.close();
    setIdeasLoading(true);
    setIdeasError("");
    const initialMessage = "마케팅 agent 실행을 준비하고 있어요.";
    setIdeasCurrentReasoning(initialMessage);
    setIdeasRecentSkill("scout-instagram-references 준비 중");
    setIdeasRecentTool("호출 대기 중");
    setIdeasEventLog([{ id: `${Date.now()}-start`, kind: "status", label: initialMessage }]);
    setIdeasStreamText("");
    setIdeasTraceId("");
    setIdeas([]);
    setSelectedIdea(null);
    setStoredUserAssets([]);
    setReferences([]);
    setMarketerCompliance([]);
    setEditorInputStatus("선택한 방향을 편집 화면으로 넘길 준비가 됐어요.");
    setScreen("ideas");

    try {
      const projectId = crypto.randomUUID();
      setActiveProjectId(projectId);

      const uploadingMessage = "업로드한 사진을 정리하고 있어요. 곧 마케팅 에이전트가 레퍼런스를 조사합니다.";
      setIdeasCurrentReasoning(uploadingMessage);
      setIdeasRecentSkill("asset_upload 실행 중");
      setIdeasRecentTool("scout-instagram-references 대기 중");
      setIdeasEventLog((previous) => [
        ...previous,
        { id: `${Date.now()}-upload-start`, kind: "tool" as const, label: "asset_upload", detail: "사용자 사진 업로드 시작" },
        { id: `${Date.now()}-reasoning-start`, kind: "reasoning" as const, label: uploadingMessage },
      ].slice(-40));

      const uploadedAssets = await uploadUserProjectAssets(
        projectId,
        files.map((file) => ({
          assetId: file.id,
          file: file.file,
          description: file.description,
        })),
      );
      setStoredUserAssets(uploadedAssets);

      setIdeasRecentSkill(`asset_upload 완료 · ${uploadedAssets.length} photos`);
      setIdeasRecentTool("scout-instagram-references 준비 중");
      setIdeasCurrentReasoning("마케팅 에이전트가 조사 주제를 정하고 레퍼런스를 찾은 뒤 두 방향을 구성해요.");
      setIdeasEventLog((previous) => [
        ...previous,
        { id: `${Date.now()}-upload-finish`, kind: "tool" as const, label: "asset_upload 완료", detail: `${uploadedAssets.length}개 사용자 사진 준비` },
      ].slice(-40));

      const response = await fetch(`/api/projects/${projectId}/ideas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: projectId,
          request: brief,
          brandDirection: brandText,
          brandContext,
          language: "ko",
          target: "instagram_carousel",
          assets: {
            assetSetId: projectId,
            items: uploadedAssets.map((asset) => ({
              assetId: asset.assetId,
              kind: "image",
              name: asset.name,
              url: asset.signedUrl,
              description: asset.description,
            })),
          },
        }),
      });

      const payload = await response.json() as {
        ideas?: Idea[];
        error?: string;
        bridgeSessionId?: string;
        traceId?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "아이디어를 만들지 못했어요");

      // Keep compatibility with an older synchronous server response while
      // the current route uses a queued SSE stream.
      if (payload.ideas) {
        setIdeas(payload.ideas);
        setIdeasLoading(false);
        return;
      }
      if (!payload.bridgeSessionId) throw new Error("마케팅 agent stream을 시작하지 못했어요");

      setIdeasTraceId(payload.traceId ?? "");
      const stream = new EventSource(`/api/marketer-bridge/${payload.bridgeSessionId}/stream`);
      marketerStream.current = stream;
      stream.addEventListener("agent_event", (event) => {
        if (marketerStream.current !== stream) return;
        const detail = JSON.parse((event as MessageEvent<string>).data) as {
          event?: {
            type?: string;
            status?: string;
            message?: string;
            text?: string;
            toolName?: string;
            args?: Record<string, unknown>;
            resultSummary?: string;
            output?: { ideas: Idea[]; references: Reference[]; compliance: ComplianceCheck[] };
            traceId?: string;
          };
        };
        const agentEvent = detail.event;
        if (!agentEvent) return;
        if (agentEvent.traceId) setIdeasTraceId(agentEvent.traceId);
        if (agentEvent.type === "assistant_delta" && agentEvent.text) {
          setIdeasStreamText((previous) => `${previous}${agentEvent.text}`.slice(-20000));
        }
        if (agentEvent.type === "reasoning_update" && agentEvent.message) {
          setIdeasCurrentReasoning(agentEvent.message);
          setIdeasEventLog((previous) => [...previous, {
            id: `${Date.now()}-${previous.length}`,
            kind: "reasoning" as const,
            label: agentEvent.message!,
          }].slice(-40));
        }
        if (agentEvent.type === "status" && agentEvent.message) {
          setIdeasCurrentReasoning(agentEvent.message);
          setIdeasEventLog((previous) => [...previous, {
            id: `${Date.now()}-${previous.length}`,
            kind: (agentEvent.status === "failed" ? "status" : "reasoning") as AgentLogEntry["kind"],
            label: agentEvent.message!,
            detail: agentEvent.status,
          }].slice(-40));
        }
        if (agentEvent.type === "tool_progress" && agentEvent.toolName && agentEvent.message) {
          setIdeasRecentTool(`${agentEvent.toolName} · 진행 중`);
          setIdeasCurrentReasoning(agentEvent.message);
          setIdeasEventLog((previous) => [...previous, {
            id: `${Date.now()}-${previous.length}`,
            kind: "tool" as const,
            label: `${agentEvent.toolName} 진행`,
            detail: agentEvent.message,
          }].slice(-40));
        }
        if (agentEvent.type === "tool_started" && agentEvent.toolName) {
          setIdeasRecentTool(`${agentEvent.toolName} 실행 중`);
          if (agentEvent.toolName === "scout_instagram_references") {
            setIdeasRecentSkill("scout-instagram-references");
          }
          const argsDetail = agentEvent.args
            ? JSON.stringify(agentEvent.args, null, 2)
            : "실행 시작";
          setIdeasEventLog((previous) => [...previous, {
            id: `${Date.now()}-${previous.length}`,
            kind: "tool" as const,
            label: `${agentEvent.toolName} 호출`,
            detail: argsDetail,
          }].slice(-40));
        }
        if (agentEvent.type === "tool_finished" && agentEvent.toolName) {
          setIdeasRecentTool(`${agentEvent.toolName} 완료`);
          setIdeasEventLog((previous) => [...previous, {
            id: `${Date.now()}-${previous.length}`,
            kind: "tool" as const,
            label: `${agentEvent.toolName} 결과`,
            detail: agentEvent.resultSummary ?? "실행 완료",
          }].slice(-40));
        }
        if (agentEvent.type === "result" && agentEvent.output) {
          const resultMessage = "두 가지 아이디어와 슬라이드 플랜을 정리했어요.";
          setIdeasCurrentReasoning(resultMessage);
          setIdeasEventLog((previous) => [...previous, {
            id: `${Date.now()}-result`,
            kind: "status" as const,
            label: resultMessage,
            detail: "completed",
          }].slice(-40));
          setIdeas(agentEvent.output.ideas);
          setReferences(agentEvent.output.references);
          setMarketerCompliance(agentEvent.output.compliance ?? []);
          setIdeasLoading(false);
          stream.close();
          marketerStream.current = null;
        }
        if (agentEvent.type === "status" && agentEvent.status === "failed") {
          setIdeasLoading(false);
          setIdeas([]);
          setIdeasError(agentEvent.message ?? "마케팅 agent가 실패했어요");
          stream.close();
          marketerStream.current = null;
        }
      });
      stream.addEventListener("error", () => {
        if (marketerStream.current !== stream) return;
        const errorMessage = "마케팅 agent stream 연결이 끊겼어요";
        setIdeasCurrentReasoning(errorMessage);
        setIdeasEventLog((previous) => [...previous, {
          id: `${Date.now()}-stream-error`,
          kind: "status" as const,
          label: errorMessage,
          detail: "error",
        }].slice(-40));
        setIdeasLoading(false);
        setIdeas([]);
        setIdeasError(errorMessage);
        stream.close();
        marketerStream.current = null;
      });
    } catch (error) {
      setIdeas([]);
      const errorMessage = error instanceof Error ? error.message : "마케팅 에이전트를 실행하지 못했어요";
      setIdeasCurrentReasoning(errorMessage);
      setIdeasEventLog((previous) => [...previous, {
        id: `${Date.now()}-request-error`,
        kind: "status" as const,
        label: errorMessage,
        detail: "error",
      }].slice(-40));
      setIdeasError(errorMessage);
      setIdeasLoading(false);
    } finally {
      // The SSE completion event owns loading=false for an async run.
    }
  }

  if (authLoading) {
    return <main className="auth-shell"><div className="auth-loading">워크스페이스를 불러오는 중…</div></main>;
  }

  if (!authUser) {
    return <AuthScreen supabase={supabase} />;
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand-mark" type="button" onClick={() => brandContext && setScreen("dashboard")} aria-label="대시보드로 이동"><span>NOMORE</span><b>BMT</b></button>
      </aside>

      <section className="main-panel">
        {screen === "onboarding" && (
          <Onboarding initialAnswers={onboardingAnswers} onSubmit={completeOnboarding} />
        )}

        {screen === "dashboard" && brandContext && (
          <Dashboard context={brandContext} storageMode={storageMode} onNewProject={() => setScreen("brief")} onEditProfile={() => setScreen("onboarding")} onSignOut={() => void supabase?.auth.signOut()} />
        )}

        {screen === "brief" && (
          <Brief brief={brief} setBrief={setBrief} files={files} fileError={fileError} onFiles={handleFiles} onRemoveFile={removeFile} onReorderFiles={reorderFiles} onDescriptionChange={updateFileDescription} onBack={() => setScreen("dashboard")} onContinue={generateIdeas} loading={ideasLoading} error={ideasError} />
        )}

        {screen === "ideas" && (
          <Ideas ideas={ideas} references={references} compliance={marketerCompliance} loading={ideasLoading} editorInputLoading={editorInputLoading} editorInputStatus={editorInputStatus} error={ideasError} ready={Boolean(activeProjectId && storedUserAssets.length)} currentReasoning={ideasCurrentReasoning} recentSkill={ideasRecentSkill} recentTool={ideasRecentTool} eventLog={ideasEventLog} streamText={ideasStreamText} traceId={ideasTraceId} selectedIdea={selectedIdea} onSelect={chooseIdea} onBack={() => setScreen("brief")} onContinue={createPost} />
        )}

        {screen === "editor" && selectedIdea && brandContext && activeProjectId && (
          <EditorPlaneMount projectId={activeProjectId} idea={selectedIdea} references={editorReferences} task={brief} brandText={brandText} brandContext={brandContext} assetItems={editorAssetItems} onBack={() => setScreen("ideas")} onFinish={(result: EditorPlaneResult) => {
            const gradients = selectedIdea.accent === "coral"
              ? ["sunset", "seafoam", "sand", "night", "coral"]
              : ["dawn", "ocean", "cream", "twilight", "blue"];
            setRenderedPost({
              ideaId: selectedIdea.id,
              slides: result.slides.map((slide, index) => ({
                nodeId: slide.nodeId,
                eyebrow: slide.eyebrow,
                title: slide.title,
                copy: slide.copy,
                assetIds: slide.assetIds,
                imageDataUrl: slide.imageDataUrl,
                gradient: gradients[index % gradients.length],
              })),
              caption: result.caption,
              previewImageUrl: result.contactSheetImageUrl,
              diagnostics: result.diagnostics,
            });
            setActiveSlide(0);
            setScreen("review");
          }} />
        )}

        {screen === "review" && renderedPost && brandContext && (
          <Review projectId={activeProjectId} post={renderedPost} instagramHandle={brandContext.instagramHandle} activeSlide={activeSlide} setActiveSlide={setActiveSlide} onBack={() => setScreen("editor")} onRestart={() => { setRenderedPost(null); setScreen("brief"); }} />
        )}
      </section>
    </main>
  );
}

function Onboarding({
  initialAnswers,
  onSubmit,
}: {
  initialAnswers: OnboardingAnswers;
  onSubmit: (answers: OnboardingAnswers) => Promise<OnboardingStorageResult>;
}) {
  const [answers, setAnswers] = useState(initialAnswers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showRequired, setShowRequired] = useState(false);

  useEffect(() => {
    setAnswers(initialAnswers);
  }, [initialAnswers]);

  function updateAnswer(field: keyof OnboardingAnswers, value: string) {
    setAnswers((previous) => ({ ...previous, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!complete) {
      setShowRequired(true);
      return;
    }
    setLoading(true);
    setError("");
    try {
      await onSubmit(answers);
    } catch (submitError) {
      const errorMessage = submitError instanceof Error
        ? submitError.message
        : submitError && typeof submitError === "object" && "message" in submitError
          ? String(submitError.message)
          : "온보딩을 저장하지 못했어요";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }

  const complete = Object.values(answers).every((answer) => answer.trim());

  return <div className="content onboarding-screen">
    <div className="onboarding-grid onboarding-form-only">
      <div className="onboarding-form-intro"><span>✦</span><div><strong>브랜드 프로필</strong><p>계정 운영 방향을 입력하면 마케터·편집자 에이전트가 이 정보를 기준으로 콘텐츠를 만듭니다.</p></div></div>
      <form className="form-card onboarding-form" onSubmit={submit}>
        <div className="form-card-top"><span className="card-index">01 — 05</span></div>
        <div className="identity-fields">
          <label className={`qa-field ${showRequired && !answers.accountName.trim() ? "missing" : ""}`} htmlFor="accountName"><span>계정 이름 <b>*</b></span><input id="accountName" aria-invalid={showRequired && !answers.accountName.trim()} value={answers.accountName} onChange={(event) => updateAnswer("accountName", event.target.value)} placeholder="예: 소도시 식탁" maxLength={80} /><small className={showRequired && !answers.accountName.trim() ? "visible" : ""}>필수 항목이에요</small></label>
          <label className={`qa-field ${showRequired && !answers.instagramHandle.trim() ? "missing" : ""}`} htmlFor="instagramHandle"><span>Instagram ID <b>*</b></span><div className="handle-input"><b>@</b><input id="instagramHandle" aria-invalid={showRequired && !answers.instagramHandle.trim()} value={answers.instagramHandle} onChange={(event) => updateAnswer("instagramHandle", event.target.value)} placeholder="smallcity.table" maxLength={64} autoCapitalize="none" /></div><small className={showRequired && !answers.instagramHandle.trim() ? "visible" : ""}>필수 항목이에요</small></label>
        </div>
        <label className={`qa-field ${showRequired && !answers.desiredMood.trim() ? "missing" : ""}`} htmlFor="desiredMood"><span>원하는 무드 <b>*</b></span><textarea id="desiredMood" aria-invalid={showRequired && !answers.desiredMood.trim()} value={answers.desiredMood} onChange={(event) => updateAnswer("desiredMood", event.target.value)} placeholder="예: 따뜻하고 차분하지만 정보는 빠르게 읽히는 분위기" maxLength={500} /><small className={showRequired && !answers.desiredMood.trim() ? "visible" : ""}>필수 항목이에요</small></label>
        <label className={`qa-field ${showRequired && !answers.mainTopics.trim() ? "missing" : ""}`} htmlFor="mainTopics"><span>주요 주제 <b>*</b></span><textarea id="mainTopics" aria-invalid={showRequired && !answers.mainTopics.trim()} value={answers.mainTopics} onChange={(event) => updateAnswer("mainTopics", event.target.value)} placeholder="예: 국내 소도시 여행, 로컬 맛집" maxLength={500} /><small className={showRequired && !answers.mainTopics.trim() ? "visible" : ""}>필수 항목이에요</small></label>
        <label className={`qa-field ${showRequired && !answers.preferredFormats.trim() ? "missing" : ""}`} htmlFor="preferredFormats"><span>유지할 형식 <b>*</b></span><textarea id="preferredFormats" aria-invalid={showRequired && !answers.preferredFormats.trim()} value={answers.preferredFormats} onChange={(event) => updateAnswer("preferredFormats", event.target.value)} placeholder="예: 표지는 짧은 한 줄, 5~7장 정도의 카드뉴스, 비속어는 사용하지 않기" maxLength={500} /><small className={showRequired && !answers.preferredFormats.trim() ? "visible" : ""}>필수 항목이에요</small></label>
        {error && <div className="onboarding-error"><span>!</span>{error}</div>}
        <button className="primary-button onboarding-submit" disabled={loading} type="submit">{loading ? "브랜드와 기존 게시물을 분석하는 중…" : "브랜드 방향 저장하기"} <span>→</span></button>
      </form>
    </div>
  </div>;
}

function AccountGrowthChart() {
  return (
    <section className="dashboard-growth-card" aria-label="최근 30일 팔로워 증가 추이">
      <div className="growth-heading">
        <div>
          <div className="section-label">ACCOUNT GROWTH</div>
          <h2>팔로워 증가 추이</h2>
        </div>
        <div className="growth-summary"><strong>+8.4%</strong><span>최근 30일</span></div>
      </div>
      <p className="growth-description">최근 30일 팔로워 추이입니다.</p>
      <div className="growth-chart">
        <div className="growth-y-axis"><span>2,500</span><span>2,400</span><span>2,300</span></div>
        <div className="growth-plot">
          <div className="growth-grid-lines"><i /><i /><i /></div>
          <svg viewBox="0 0 700 190" role="img" aria-label="30일 동안 2,294명에서 2,486명으로 증가한 팔로워 추이">
            <defs><linearGradient id="growth-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#3182f6" stopOpacity=".2" /><stop offset="100%" stopColor="#3182f6" stopOpacity="0" /></linearGradient></defs>
            <path className="growth-area" d="M0 155 C80 151 105 138 170 140 S260 128 330 116 S425 102 490 91 S590 69 700 35 L700 190 L0 190 Z" />
            <path className="growth-line" d="M0 155 C80 151 105 138 170 140 S260 128 330 116 S425 102 490 91 S590 69 700 35" />
            <circle className="growth-point" cx="0" cy="155" r="4" />
            <circle className="growth-point" cx="120" cy="145" r="4" />
            <circle className="growth-point" cx="240" cy="130" r="4" />
            <circle className="growth-point" cx="360" cy="111" r="4" />
            <circle className="growth-point" cx="480" cy="93" r="4" />
            <circle className="growth-point" cx="590" cy="68" r="4" />
            <circle className="growth-point latest" cx="700" cy="35" r="5" />
          </svg>
          <div className="growth-x-axis"><span>7/04</span><span>7/11</span><span>7/18</span><span>7/25</span><span>8/01</span></div>
        </div>
      </div>
    </section>
  );
}

function TopPosts() {
  const posts = [
    { rank: "01", image: "/top-posts/top-post-1.jpeg", label: "저장형 정보", title: "강릉에서 꼭 먹어야 할 한 그릇", hook: "여행 전에 저장해두면 좋은 로컬 맛집", reach: "12.8K", likes: "1,024", engagement: "8.1%" },
    { rank: "02", image: "/top-posts/top-post-2.jpeg", label: "감성형 기록", title: "바다보다 오래 기억된 골목", hook: "관광지보다 이 장면이 더 좋았던 이유", reach: "9.6K", likes: "782", engagement: "7.4%" },
    { rank: "03", image: "/top-posts/top-post-3.jpeg", label: "경험형 후기", title: "20분을 기다려도 다시 갈 식당", hook: "기다린 시간이 아깝지 않았던 한 끼", reach: "8.9K", likes: "691", engagement: "6.9%" },
  ];

  return (
    <section className="top-posts-section" aria-label="성과가 좋았던 게시물 TOP 3">
      <div className="top-posts-heading"><div><div className="section-label">TOP PERFORMING POSTS</div><h2>성과가 좋았던 게시물</h2></div><span>TOP 3 · 최근 30일</span></div>
      <p className="top-posts-description">최근 30일 도달·참여·저장이 높았던 게시물입니다.</p>
      <div className="top-posts-grid">
        {posts.map((post) => <article className="top-post-card" key={post.rank}>
          <div className="top-post-image"><img src={post.image} alt={`${post.rank}위 게시물 음식 사진`} /></div>
          <div className="top-post-card-heading"><span className="top-post-rank">{post.rank}</span><span className="top-post-label">{post.label}</span></div>
          <h3>{post.title}</h3>
          <p className="top-post-hook">“{post.hook}”</p>
          <div className="top-post-metrics"><div><span>도달</span><strong>{post.reach}</strong></div><div><span>좋아요</span><strong>{post.likes}</strong></div><div><span>참여율</span><strong>{post.engagement}</strong></div></div>
          <div className="top-post-insight"><span>✦</span> 저장과 공유를 이끈 정보형 훅</div>
        </article>)}
      </div>
    </section>
  );
}

function Dashboard({
  context,
  storageMode,
  onNewProject,
  onEditProfile,
  onSignOut,
}: {
  context: BrandContext;
  storageMode: OnboardingStorageResult["storage"] | null;
  onNewProject: () => void;
  onEditProfile: () => void;
  onSignOut: () => void;
}) {
  return <div className="content dashboard-page"><div className="page-heading"><div><h1>대시보드</h1></div><div className="dashboard-heading-actions"><div className="account-actions"><button className="account-action" onClick={onEditProfile}>프로필 수정</button><button className="account-action" onClick={onSignOut}>로그아웃</button></div><div className="dashboard-actions"><a className="secondary-link" href="/analysis">Instagram 계정 분석</a><button className="primary-button compact" onClick={onNewProject}>새 게시물 만들기 <span>＋</span></button></div></div></div><div className="dashboard-grid"><div className="profile-panel"><div className="section-label">YOUR BRAND DIRECTION</div><div className="profile-quote"><span className="profile-identity">{context.accountName}(@{context.instagramHandle})</span>{context.brandSummary.replace(/^[“"]/, "").replace(/[”"]$/, "").replace(`${context.accountName}(@${context.instagramHandle})`, "")}</div><div className="profile-tags">{context.moodKeywords.slice(0, 3).map((keyword) => <span key={keyword}>{keyword}</span>)}</div><button className="text-button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>마케터·편집자 공통 컨텍스트 적용됨 ✓</button></div><div className="activity-panel account-summary-panel"><div className="account-summary-heading"><div><div className="section-label">ACCOUNT STATUS</div><h2>내 계정 상태</h2></div><span className="summary-period">최근 30일</span></div><p className="summary-description">지난 30일 대비 주요 지표입니다.</p><div className="summary-metrics"><div className="summary-metric"><span>팔로워</span><strong>2,486</strong><small className="positive">+8.4%</small></div><div className="summary-metric"><span>도달한 계정</span><strong>18.6K</strong><small className="positive">+12.7%</small></div><div className="summary-metric"><span>참여율</span><strong>6.8%</strong><small className="positive">+1.2%p</small></div></div><div className="summary-footnote"><span className="summary-status-dot" /> 최근 30일 주요 지표가 상승했습니다.</div></div></div><AccountGrowthChart /><TopPosts /><div className="dashboard-footer"><span>CONTEXT</span><p>마케터는 훅과 아이디어 방향에, 편집자는 문장 밀도·이미지 처리·슬라이드 흐름에 이 프로필을 사용합니다.</p></div><details className="agent-context-panel"><summary>Agent Context JSON 보기</summary><p>마케터와 편집자 Agent에 전달되는 동일한 구조화 컨텍스트입니다.</p><pre>{JSON.stringify(context, null, 2)}</pre></details></div>;
}

function Brief({ brief, setBrief, files, fileError, onFiles, onRemoveFile, onReorderFiles, onDescriptionChange, onBack, onContinue, loading, error }: { brief: string; setBrief: (value: string) => void; files: UploadedAsset[]; fileError: string; onFiles: (event: ChangeEvent<HTMLInputElement>) => void; onRemoveFile: (index: number) => void; onReorderFiles: (fromIndex: number, toIndex: number) => void; onDescriptionChange: (index: number, description: string) => void; onBack: () => void; onContinue: () => void; loading: boolean; error: string }) {
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const isReady = Boolean(brief.trim()) && files.length > 0;
  const activeAssetIndexFromId = activeAssetId ? files.findIndex((file) => file.id === activeAssetId) : -1;
  const safeAssetIndex = activeAssetIndexFromId >= 0 ? activeAssetIndexFromId : 0;
  const activeAsset = files[safeAssetIndex];

  useEffect(() => {
    if (files.length === 0) return;
    if (!files.some((file) => file.id === activeAssetId)) setActiveAssetId(files[0].id);
  }, [files, activeAssetId]);

  const carouselRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const slideRefs = useRef(new Map<string, HTMLDivElement>());
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const centerActiveSlide = useCallback(() => {
    const carousel = carouselRef.current;
    const track = trackRef.current;
    const activeEl = activeAssetId ? slideRefs.current.get(activeAssetId) : undefined;
    if (!carousel || !track || !activeEl) return;
    // Slide the whole filmstrip so the active photo lands in the center of the viewport.
    const offset = carousel.clientWidth / 2 - (activeEl.offsetLeft + activeEl.offsetWidth / 2);
    track.style.transform = `translateX(${offset}px)`;
  }, [files, activeAssetId]);

  useLayoutEffect(() => {
    centerActiveSlide();
  }, [centerActiveSlide]);

  useEffect(() => {
    window.addEventListener("resize", centerActiveSlide);
    return () => window.removeEventListener("resize", centerActiveSlide);
  }, [centerActiveSlide]);

  function removeFileAt(index: number) {
    const removedId = files[index]?.id;
    onRemoveFile(index);
    if (removedId === undefined || removedId !== activeAssetId) return;
    const remaining = files.filter((file) => file.id !== removedId);
    const nextIndex = Math.max(0, Math.min(index, remaining.length - 1));
    setActiveAssetId(remaining[nextIndex]?.id ?? null);
  }

  return <div className="content brief-screen"><div className="page-heading"><div><div className="content-kicker">콘텐츠 요청 · 02</div><h1>콘텐츠 <em>요청</em></h1><p className="heading-description">게시물 방향을 적고 사진을 업로드하세요. 사진 설명은 선택입니다.</p></div><div className="progress-copy">01 <span>/</span> 02<br /><small>PROJECT BRIEF</small></div></div><div className="story-brief-card"><div className="section-label">POST DIRECTION <span>REQUIRED</span></div><label htmlFor="brief">1. 게시물 방향</label><textarea id="brief" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="예: 이번에 3박 4일 강릉 여행을 다녀왔어요. 여행의 흐름이 보이도록 일차별로 나누어 만들어주세요." /><div className="brief-hint">기간·주제·원하는 구성 등 전체 방향을 자세히 적을수록 결과가 좋아집니다.</div></div><section className="asset-section"><div className="asset-section-heading"><div><div className="section-label">YOUR ASSETS <span>{files.length ? `${files.length} FILES` : "UP TO 9 FILES"}</span></div><h2>2. 사진 업로드</h2><p>사진 설명은 선택입니다. 업로드 순서가 슬라이드 순서의 기준이 됩니다.</p></div><label className="asset-add-button"><input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple onChange={onFiles} /><span>＋</span> 사진 추가</label></div>{fileError && <div className="asset-upload-error" role="alert">{fileError}</div>}{files.length === 0 ? <label className="upload-zone story-upload-zone"><input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple onChange={onFiles} /><div className="upload-icon">↑</div><strong>사진을 여기에 놓거나 클릭하세요</strong><span>JPG, JPEG, PNG, WEBP · 장당 최대 10MB · 최대 9장</span></label> : <><div className="asset-carousel" ref={carouselRef}><button className="asset-carousel-arrow previous" type="button" aria-label="이전 사진" disabled={safeAssetIndex === 0} onClick={() => setActiveAssetId(files[Math.max(0, safeAssetIndex - 1)]?.id ?? null)}>‹</button><div className="asset-carousel-track" ref={trackRef}>{files.map((file, index) => { const isActive = index === safeAssetIndex; return <div className={`asset-carousel-slide ${isActive ? "active" : ""} ${dragOverIndex === index ? "drag-over" : ""}`} key={file.id} ref={(el) => { if (el) slideRefs.current.set(file.id, el); else slideRefs.current.delete(file.id); }} role="button" tabIndex={0} onClick={() => setActiveAssetId(file.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveAssetId(file.id); } }} onDragOver={(event) => { if (dragIndexRef.current === null) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverIndex(index); }} onDragLeave={() => setDragOverIndex((current) => (current === index ? null : current))} onDrop={(event) => { event.preventDefault(); const from = dragIndexRef.current; dragIndexRef.current = null; setDragOverIndex(null); if (from === null || from === index) return; onReorderFiles(from, index); }} aria-label={`${index + 1}번째 사진 보기`}><img src={file.previewUrl} alt={`${index + 1}번째 업로드 사진: ${file.name}`} onLoad={centerActiveSlide} /><span>{String(index + 1).padStart(2, "0")}</span><button type="button" className="asset-carousel-slide-delete" onClick={(event) => { event.stopPropagation(); removeFileAt(index); }} aria-label={`${index + 1}번째 사진 삭제`} /><button type="button" className="asset-carousel-slide-handle" draggable onClick={(event) => event.stopPropagation()} onDragStart={(event) => { dragIndexRef.current = index; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }} onDragEnd={() => { dragIndexRef.current = null; setDragOverIndex(null); }} aria-label={`${index + 1}번째 사진 순서 변경`}>≡</button></div>; })}</div><button className="asset-carousel-arrow next" type="button" aria-label="다음 사진" disabled={safeAssetIndex === files.length - 1} onClick={() => setActiveAssetId(files[Math.min(files.length - 1, safeAssetIndex + 1)]?.id ?? null)}>›</button></div><div className="asset-carousel-progress"><span>{safeAssetIndex + 1} / {files.length}</span><div>{files.map((file, index) => <button className={index === safeAssetIndex ? "active" : ""} type="button" key={file.id} onClick={() => setActiveAssetId(file.id)} aria-label={`${index + 1}번째 사진으로 이동`} />)}</div></div>{activeAsset && <div className="active-asset-description"><div className="active-asset-heading"><div><span>PHOTO {String(safeAssetIndex + 1).padStart(2, "0")}</span><strong>사진 설명 <small>(선택)</small></strong></div></div><textarea id={`asset-description-${activeAsset.id}`} value={activeAsset.description} onChange={(event) => onDescriptionChange(safeAssetIndex, event.target.value)} placeholder="선택사항 · 예: 여행 2일차에 방문한 식당, 점심에는 20분 정도 기다렸어요." /></div>}</>}</section><div className="brief-footer"><button className="secondary-button" onClick={onBack}>← 이전</button><div>{error && <span className="asset-upload-error">{error}</span>}<button className="primary-button" disabled={!isReady || loading} onClick={onContinue}>{loading ? "분석 중…" : "아이디어 생성"} <b>→</b></button></div></div></div>;
}

function slidePlanLabel(slide: Idea["slides"][number], index: number): string {
  const preferred = slide.text?.find(
    (item) => item.role === "title" || item.role === "hook",
  );
  return preferred?.content ?? slide.text?.[0]?.content ?? `슬라이드 ${index + 1}`;
}

function Ideas({ ideas, references, compliance, loading, editorInputLoading, editorInputStatus, error, ready, currentReasoning, recentSkill, recentTool, eventLog, streamText, traceId, selectedIdea, onSelect, onBack, onContinue }: { ideas: Idea[]; references: Reference[]; compliance: ComplianceCheck[]; loading: boolean; editorInputLoading: boolean; editorInputStatus: string; error: string; ready: boolean; currentReasoning: string; recentSkill: string; recentTool: string; eventLog: AgentLogEntry[]; streamText: string; traceId: string; selectedIdea: Idea | null; onSelect: (idea: Idea) => void; onBack: () => void; onContinue: () => void }) {
  const referenceById = new Map(references.map((reference) => [reference.id, reference]));
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [eventLog]);
  return (
    <div className="content ideas-screen">
      <div className="page-heading">
        <div>
          <div className="content-kicker">콘텐츠 방향 · 03</div>
          <h1>콘텐츠 방향 <em>선택</em></h1>
          <p className="heading-description">업로드한 사진과 브랜드 정보로 만든 두 가지 방향입니다. 하나를 선택해 편집으로 넘어가세요.</p>
        </div>
      </div>
      {error && <div className="brief-hint"><span>!</span> {error}</div>}
      <div className="idea-grid">
        {loading ? (
          <div className="idea-card idea-card-stream" aria-busy="true">
            <div className="idea-card-body">
              <div className="idea-label">CONTENT DIRECTION</div>
              <h2>콘텐츠 방향을 정리하고 있어요…</h2>
              <p>업로드한 사진과 입력한 내용을 바탕으로 두 가지 방향을 준비하고 있습니다.</p>
              <div className="marketer-stream-heading">
                <span><i /> MARKETING AGENT STREAM</span>
                {traceId && <small title={traceId}>TRACE {traceId.slice(-10)}</small>}
              </div>
              <div className="marketer-run-summary" aria-live="polite">
                <div className="marketer-run-row reasoning">
                  <span className="marketer-run-icon">✦</span>
                  <div><span className="marketer-run-label">CURRENT ACTIVITY</span><strong>{currentReasoning}</strong></div>
                </div>
                <div className="marketer-run-row skill">
                  <span className="marketer-run-icon">◇</span>
                  <div><span className="marketer-run-label">ACTIVE SKILL</span><strong>{recentSkill}</strong></div>
                </div>
                <div className="marketer-run-row tool">
                  <span className="marketer-run-icon">⌁</span>
                  <div><span className="marketer-run-label">MOST RECENT TOOL</span><strong>{recentTool}</strong></div>
                </div>
              </div>
              <details className="marketer-event-details" open>
                <summary><span>실제 tool 호출 · 모델 활동 로그</span><span>{eventLog.length} events</span></summary>
                <div className="marketer-event-log" ref={logRef}>
                  {eventLog.map((entry) => (
                    <div className={`marketer-event-row ${entry.kind}`} key={entry.id}>
                      <span>{entry.kind.toUpperCase()}</span>
                      <p><strong>{entry.label}</strong>{entry.detail && <small>{entry.detail}</small>}</p>
                    </div>
                  ))}
                </div>
              </details>
              <div className="marketer-output-signal">
                <span>MODEL OUTPUT</span>
                <i className={streamText ? "active" : ""} />
                <strong>{streamText ? `${streamText.length.toLocaleString()} characters received` : "응답 대기 중"}</strong>
              </div>
            </div>
          </div>
        ) : (
          ideas.map((idea) => (
            <button className={`idea-card ${selectedIdea?.id === idea.id ? "selected" : ""}`} key={idea.id} onClick={() => onSelect(idea)}>
              <div className={`idea-visual ${idea.accent}`}><div className="visual-noise" /><span>{idea.label}</span><i>{idea.slides.length}장</i></div>
              <div className="idea-card-body">
                <div className="idea-label">{idea.format}</div>
                <h2>{idea.title}</h2>
                <p>{idea.description}</p>

                <div className="idea-plan-block">
                  <div className="idea-plan-label">DESIGN DIRECTION</div>
                  <p className="idea-design-direction">{idea.designDirection}</p>
                </div>

                {(() => {
                  const cardReferenceIds = [...new Set([
                    ...idea.referenceIds,
                    ...idea.slides.flatMap((slide) => slide.referenceInspirations.map((inspiration) => inspiration.referenceId)),
                  ])];
                  if (!cardReferenceIds.length) {
                    return <div className="idea-refs empty">참고한 레퍼런스 없음 · 사용자 사진 기반</div>;
                  }
                  return (
                    <div className="idea-refs">
                      <div className="idea-plan-label">참고 레퍼런스 {cardReferenceIds.length}</div>
                      <div className="idea-refs-list">
                        {cardReferenceIds.map((referenceId) => {
                          const reference = referenceById.get(referenceId);
                          return (
                            <span className="idea-ref-chip" key={referenceId} title={reference?.instagramUrl}>
                              {reference?.previewImageUrl
                                ? <img src={reference.previewImageUrl} alt="레퍼런스" loading="lazy" />
                                : <em>ref</em>}
                              <small>{reference?.creatorHandle ? `@${reference.creatorHandle}` : referenceId}</small>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                <div className="idea-plan-block">
                  <div className="idea-plan-label">슬라이드 설계 · {idea.slides.length}장</div>
                  <ol className="idea-plan">
                    {idea.slides.map((slide, index) => (
                      <li className="idea-plan-row" key={index}>
                        <span className="idea-plan-index">{String(index + 1).padStart(2, "0")}</span>
                        <div className="idea-plan-copy">
                          <strong>{slidePlanLabel(slide, index)}</strong>
                          <small>{slide.intent}</small>
                          <div className="idea-plan-tags">
                            <span className={`idea-treatment ${slide.imageTreatment}`}>{slide.imageTreatment === "full_bleed" ? "full-bleed" : "contained"}</span>
                            <span className="idea-treatment neutral">{slide.text?.length ?? 0} text</span>
                            {slide.referenceInspirations.map((inspiration, refIndex) => (
                              <span className="idea-treatment ref" key={refIndex} title={`${inspiration.borrowed} → ${inspiration.adaptedHow}`}>ref {inspiration.borrowed}</span>
                            ))}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
              <div className="select-mark">{selectedIdea?.id === idea.id ? "✓" : "○"}</div>
            </button>
          ))
        )}
      </div>
      {!loading && compliance.length > 0 && (
        <section className="marketer-compliance" aria-label="마케터 절차 검증">
          <div className="marketer-compliance-heading">MARKETER 절차 검증</div>
          <div className="marketer-compliance-list">
            {compliance.map((check) => (
              <div className={`compliance-row ${check.passed ? "pass" : "fail"}`} key={check.id}>
                <span className="compliance-mark">{check.passed ? "✓" : "!"}</span>
                <div>
                  <strong>{check.label}</strong>
                  <small>{check.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {editorInputLoading && (
        <section className="editor-input-planner-card" aria-live="polite" aria-busy={editorInputLoading}>
          <div className="editor-input-planner-heading">
            <span><i className="active" /> 편집 화면 준비</span>
          </div>
          <strong>{editorInputStatus}</strong>
          <p>마케터가 카드별로 완성한 슬라이드 플랜을 편집 화면으로 그대로 전달합니다.</p>
        </section>
      )}
      <div className="idea-footer">
        <button className="secondary-button" onClick={onBack}>← 요청 수정</button>
        <button className="primary-button" disabled={!selectedIdea || loading || editorInputLoading || !ready} onClick={onContinue}>이 방향으로 제작하기 <span>→</span></button>
      </div>
    </div>
  );
}

function Review({ projectId, post, instagramHandle, activeSlide, setActiveSlide, onBack, onRestart }: { projectId: string; post: RenderedPost; instagramHandle: string; activeSlide: number; setActiveSlide: (value: number) => void; onBack: () => void; onRestart: () => void }) {
  const slide = post.slides[activeSlide];
  const previewImageUrl = slide.imageDataUrl ?? post.previewImageUrl;
  const [caption, setCaption] = useState(post.caption);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const [connectedAccount, setConnectedAccount] = useState(instagramHandle);
  const [accountStatus, setAccountStatus] = useState<"checking" | "ready" | "error">("checking");
  const [accountError, setAccountError] = useState("");
  const contentReady = post.slides.length >= 2 && post.slides.length <= 10
    && post.slides.every((item) => Boolean(item.imageDataUrl));
  const canPublish = contentReady && accountStatus === "ready";

  useEffect(() => {
    let active = true;
    void fetch("/api/instagram/publish")
      .then(async (response) => {
        const payload = await response.json() as {
          profile?: { username?: string };
          error?: string;
        };
        if (active && response.ok && payload.profile?.username) {
          setConnectedAccount(payload.profile.username);
          setAccountStatus("ready");
          return;
        }
        if (active) {
          setAccountStatus("error");
          setAccountError(payload.error ?? "연결된 Instagram 계정을 확인하지 못했어요.");
        }
      })
      .catch(() => {
        if (!active) return;
        setAccountStatus("error");
        setAccountError("연결된 Instagram 계정을 확인하지 못했어요.");
      });
    return () => {
      active = false;
    };
  }, []);

  function downloadSlides() {
    post.slides.forEach((item, index) => {
      if (!item.imageDataUrl) return;
      const link = document.createElement("a");
      link.href = item.imageDataUrl;
      link.download = `bmt-card-${String(index + 1).padStart(2, "0")}.png`;
      link.click();
    });
  }

  async function publishToInstagram() {
    if (!canPublish || publishing || publishedUrl) return;
    const confirmed = window.confirm(
      `연결된 Instagram @${connectedAccount} 계정에 지금 게시할까요?\n게시 후에는 앱에서 자동으로 취소할 수 없어요.`,
    );
    if (!confirmed) return;

    setPublishing(true);
    setPublishError("");
    try {
      const storagePaths = await uploadRenderedProjectAssets(
        projectId,
        post.slides.map((item, index) => {
          if (!item.imageDataUrl) {
            throw new Error(`${index + 1}번째 슬라이드 이미지가 없어요.`);
          }
          return { index, imageDataUrl: item.imageDataUrl };
        }),
      );
      const response = await fetch("/api/instagram/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, caption, storagePaths }),
      });
      const payload = await response.json() as {
        permalink?: string | null;
        mediaId?: string;
        error?: string;
      };
      if (!response.ok || !payload.mediaId) {
        throw new Error(payload.error ?? "Instagram 게시에 실패했어요.");
      }
      setPublishedUrl(
        payload.permalink
          ?? `https://www.instagram.com/${connectedAccount}/`,
      );
    } catch (error) {
      setPublishError(
        error instanceof Error ? error.message : "Instagram 게시에 실패했어요.",
      );
    } finally {
      setPublishing(false);
    }
  }

  return <div className="content review-screen"><div className="page-heading"><div><div className="content-kicker">EDITOR AGENT / 03</div><h1>게시물이 <em>완성되었어요</em></h1><p className="heading-description">다운로드하거나 연결된 Instagram 계정에 바로 게시할 수 있어요.</p></div><div className="render-status"><span className="status-orb green" /> READY TO REVIEW</div></div><div className="review-grid"><div className={`post-preview ${slide.gradient} ${previewImageUrl ? "agent-rendered" : ""}`}>{previewImageUrl ? <img className="agent-rendered-image" src={previewImageUrl} alt={`${activeSlide + 1}번째 편집자 에이전트 결과`} /> : <><div className="preview-top"><span>BMT</span><span>{slide.eyebrow}</span></div><div className="preview-content"><div className="preview-eyebrow">{slide.eyebrow}</div><h2>{slide.title}</h2><p>{slide.copy}</p></div><div className="preview-bottom"><span>@{instagramHandle}</span><span>✦</span></div></>}</div><div className="review-info"><div className="section-label">CAROUSEL PREVIEW <span>{activeSlide + 1} / {post.slides.length}</span></div><div className="slide-strip">{post.slides.map((item, index) => <button className={index === activeSlide ? "active" : ""} key={`${item.nodeId ?? item.title}-${index}`} onClick={() => setActiveSlide(index)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong></button>)}</div><div className="caption-box"><div className="section-label">CAPTION</div><textarea aria-label="Instagram 게시물 캡션" value={caption} maxLength={2200} onChange={(event) => setCaption(event.target.value)} /><small>{caption.length} / 2,200</small></div>{!contentReady && <div className="publish-message error">Instagram 캐러셀은 완성된 이미지 2~10장이 필요해요. 현재 결과는 다운로드만 가능해요.</div>}{accountStatus === "error" && <div className="publish-message error">{accountError}</div>}{publishError && <div className="publish-message error" role="alert">{publishError}</div>}{publishedUrl && <div className="publish-message success">게시가 완료됐어요. <a href={publishedUrl} target="_blank" rel="noreferrer">Instagram에서 보기 ↗</a></div>}<div className="review-publish-target">게시 대상 <strong>{accountStatus === "checking" ? "계정 확인 중…" : `@${connectedAccount}`}</strong></div><div className="review-action-grid"><button className="secondary-button" onClick={downloadSlides}>게시물 다운로드 <span>↓</span></button><button className="primary-button instagram-publish-button" disabled={!canPublish || publishing || Boolean(publishedUrl)} onClick={publishToInstagram}>{publishedUrl ? "게시 완료 ✓" : publishing ? "Instagram 게시 중…" : "Instagram에 게시"} <span>↗</span></button></div><div className="button-row review-secondary-actions"><button className="secondary-button" onClick={onBack}>← 아이디어 변경</button><button className="regenerate-button" onClick={onRestart}>↻ 새로운 게시물 만들기</button></div>{post.diagnostics && <details className="agent-context-panel"><summary>EditorInput · Agent Trace 보기</summary><p>다음 실험에서 입력 품질과 실행 결과를 함께 비교할 수 있도록 보존된 진단 정보입니다.</p><pre>{JSON.stringify(post.diagnostics, null, 2)}</pre></details>}</div></div></div>;
}
