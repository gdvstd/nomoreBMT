"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { User } from "@supabase/supabase-js";
import { mockIdeas, renderMockPost } from "@/lib/mock-agents";
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
import { getSupabaseBrowserClient } from "@/lib/supabase";
import type { Idea, RenderedPost, Screen } from "@/lib/types";

type UploadedAsset = {
  id: string;
  name: string;
  previewUrl: string;
  description: string;
  dataUrl: string;
};

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;


type AgentLogEntry = {
  id: string;
  kind: "reasoning" | "tool" | "status";
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
  const [ideas, setIdeas] = useState<Idea[]>(mockIdeas);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [ideasError, setIdeasError] = useState("");
  const [fileError, setFileError] = useState("");
  const [ideasCurrentReasoning, setIdeasCurrentReasoning] = useState("마케팅 agent 실행을 준비하고 있어요.");
  const [ideasRecentTool, setIdeasRecentTool] = useState("호출 대기 중");
  const [ideasEventLog, setIdeasEventLog] = useState<AgentLogEntry[]>([]);
  const [ideasStreamText, setIdeasStreamText] = useState("");
  const [ideasTraceId, setIdeasTraceId] = useState("");
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
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

    if (invalidFormat.length > 0) {
      setFileError("JPG, JPEG, PNG, WEBP 형식의 이미지만 올릴 수 있어요.");
    } else if (oversized.length > 0) {
      setFileError("이미지 한 장의 크기는 10MB 이하여야 해요.");
    } else {
      setFileError("");
    }

    const selected = await Promise.all(valid.map(async (file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      dataUrl: await readFileAsDataUrl(file),
      description: "",
    })));
    setFiles((previous) => {
      const combined = [...previous, ...selected];
      combined.slice(20).forEach((file) => URL.revokeObjectURL(file.previewUrl));
      return combined.slice(0, 20);
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
  }

  function createPost() {
    if (!selectedIdea) return;
    setRenderedPost(renderMockPost(selectedIdea.id));
    setActiveSlide(0);
    setScreen("editor");
  }

  async function generateIdeas() {
    marketerStream.current?.close();
    setIdeasLoading(true);
    setIdeasError("");
    const initialMessage = "마케팅 agent 실행을 준비하고 있어요.";
    setIdeasCurrentReasoning(initialMessage);
    setIdeasRecentTool("호출 대기 중");
    setIdeasEventLog([{ id: `${Date.now()}-start`, kind: "status", label: initialMessage }]);
    setIdeasStreamText("");
    setIdeasTraceId("");
    setSelectedIdea(null);
    setScreen("ideas");

    try {
      const projectId = crypto.randomUUID();
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
            items: files.map((file, index) => ({
              assetId: `${projectId}-asset-${index + 1}`,
              kind: "image",
              name: file.name,
              url: file.dataUrl,
              description: file.description,
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
            ideas?: Idea[];
            traceId?: string;
          };
        };
        const agentEvent = detail.event;
        if (!agentEvent) return;
        if (agentEvent.traceId) setIdeasTraceId(agentEvent.traceId);
        if (agentEvent.type === "assistant_delta" && agentEvent.text) {
          setIdeasStreamText((previous) => `${previous}${agentEvent.text}`.slice(-20000));
        }
        if (agentEvent.type === "status" && agentEvent.message) {
          setIdeasCurrentReasoning(agentEvent.message);
          setIdeasEventLog((previous) => [{
            id: `${Date.now()}-${previous.length}`,
            kind: (agentEvent.status === "failed" ? "status" : "reasoning") as AgentLogEntry["kind"],
            label: agentEvent.message!,
            detail: agentEvent.status,
          }, ...previous].slice(0, 40));
        }
        if (agentEvent.type === "tool_started" && agentEvent.toolName) {
          setIdeasRecentTool(`${agentEvent.toolName} 실행 중`);
          setIdeasEventLog((previous) => [{
            id: `${Date.now()}-${previous.length}`,
            kind: "tool" as const,
            label: agentEvent.toolName!,
            detail: "실행 시작",
          }, ...previous].slice(0, 40));
        }
        if (agentEvent.type === "tool_finished" && agentEvent.toolName) {
          setIdeasRecentTool(`${agentEvent.toolName} 완료`);
          setIdeasEventLog((previous) => [{
            id: `${Date.now()}-${previous.length}`,
            kind: "tool" as const,
            label: agentEvent.toolName!,
            detail: "실행 완료",
          }, ...previous].slice(0, 40));
        }
        if (agentEvent.type === "result" && agentEvent.ideas) {
          const resultMessage = "두 가지 아이디어를 정리했어요.";
          setIdeasCurrentReasoning(resultMessage);
          setIdeasEventLog((previous) => [{
            id: `${Date.now()}-result`,
            kind: "status" as const,
            label: resultMessage,
            detail: "completed",
          }, ...previous].slice(0, 40));
          setIdeas(agentEvent.ideas);
          setIdeasLoading(false);
          stream.close();
          marketerStream.current = null;
        }
        if (agentEvent.type === "status" && agentEvent.status === "failed") {
          setIdeasLoading(false);
          setIdeas(mockIdeas);
          setIdeasError(agentEvent.message ?? "마케팅 agent가 실패했어요");
          stream.close();
          marketerStream.current = null;
        }
      });
      stream.addEventListener("error", () => {
        if (marketerStream.current !== stream) return;
        const errorMessage = "마케팅 agent stream 연결이 끊겼어요";
        setIdeasCurrentReasoning(errorMessage);
        setIdeasEventLog((previous) => [{
          id: `${Date.now()}-stream-error`,
          kind: "status" as const,
          label: errorMessage,
          detail: "error",
        }, ...previous].slice(0, 40));
        setIdeasLoading(false);
        setIdeas(mockIdeas);
        setIdeasError(errorMessage);
        stream.close();
        marketerStream.current = null;
      });
    } catch (error) {
      // The local UI remains explorable without credentials; the banner makes
      // it explicit that these are the existing mock ideas, not an agent run.
      setIdeas(mockIdeas);
      const errorMessage = error instanceof Error ? error.message : "마케팅 에이전트를 실행하지 못했어요";
      setIdeasCurrentReasoning(errorMessage);
      setIdeasEventLog((previous) => [{
        id: `${Date.now()}-request-error`,
        kind: "status" as const,
        label: errorMessage,
        detail: "error",
      }, ...previous].slice(0, 40));
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
          <Ideas ideas={ideas} loading={ideasLoading} error={ideasError} selectedIdea={selectedIdea} onSelect={chooseIdea} onBack={() => setScreen("brief")} onContinue={createPost} />
        )}

        {screen === "editor" && selectedIdea && brandContext && (
          <EditorPlaneMount idea={selectedIdea} task={brief} brandText={brandText} brandContext={brandContext} assetItems={files} onBack={() => setScreen("ideas")} onFinish={(result) => { setRenderedPost((post) => post ? { ...post, previewImageUrl: result?.imageDataUrl } : { ...renderMockPost(selectedIdea.id), previewImageUrl: result?.imageDataUrl }); setActiveSlide(0); setScreen("review"); }} />
        )}

        {screen === "review" && renderedPost && brandContext && (
          <Review post={renderedPost} instagramHandle={brandContext.instagramHandle} activeSlide={activeSlide} setActiveSlide={setActiveSlide} onBack={() => setScreen("editor")} onRestart={() => { setRenderedPost(null); setScreen("brief"); }} />
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
      <div className="onboarding-form-intro"><span>✦</span><div><strong>짧고 편하게 답해주세요</strong><p>정답은 없어요. 지금 운영하고 싶은 방향을 평소 말투로 적으면 됩니다.</p></div></div>
      <form className="form-card onboarding-form" onSubmit={submit}>
        <div className="form-card-top"><span className="card-index">01 — 05</span></div>
        <div className="identity-fields">
          <label className={`qa-field ${showRequired && !answers.accountName.trim() ? "missing" : ""}`} htmlFor="accountName"><span>계정 이름 <b>*</b></span><input id="accountName" aria-invalid={showRequired && !answers.accountName.trim()} value={answers.accountName} onChange={(event) => updateAnswer("accountName", event.target.value)} placeholder="예: 소도시 식탁" maxLength={80} /><small className={showRequired && !answers.accountName.trim() ? "visible" : ""}>필수 항목이에요</small></label>
          <label className={`qa-field ${showRequired && !answers.instagramHandle.trim() ? "missing" : ""}`} htmlFor="instagramHandle"><span>Instagram ID <b>*</b></span><div className="handle-input"><b>@</b><input id="instagramHandle" aria-invalid={showRequired && !answers.instagramHandle.trim()} value={answers.instagramHandle} onChange={(event) => updateAnswer("instagramHandle", event.target.value)} placeholder="smallcity.table" maxLength={64} autoCapitalize="none" /></div><small className={showRequired && !answers.instagramHandle.trim() ? "visible" : ""}>필수 항목이에요</small></label>
        </div>
        <label className={`qa-field ${showRequired && !answers.desiredMood.trim() ? "missing" : ""}`} htmlFor="desiredMood"><span>어떤 mood를 원하세요? <b>*</b></span><textarea id="desiredMood" aria-invalid={showRequired && !answers.desiredMood.trim()} value={answers.desiredMood} onChange={(event) => updateAnswer("desiredMood", event.target.value)} placeholder="예: 따뜻하고 차분하지만 정보는 빠르게 읽히는 분위기" maxLength={500} /><small className={showRequired && !answers.desiredMood.trim() ? "visible" : ""}>필수 항목이에요</small></label>
        <label className={`qa-field ${showRequired && !answers.mainTopics.trim() ? "missing" : ""}`} htmlFor="mainTopics"><span>주로 어떤 주제를 다루시나요? <b>*</b></span><textarea id="mainTopics" aria-invalid={showRequired && !answers.mainTopics.trim()} value={answers.mainTopics} onChange={(event) => updateAnswer("mainTopics", event.target.value)} placeholder="예: 국내 소도시 여행, 로컬 맛집" maxLength={500} /><small className={showRequired && !answers.mainTopics.trim() ? "visible" : ""}>필수 항목이에요</small></label>
        <label className={`qa-field ${showRequired && !answers.preferredFormats.trim() ? "missing" : ""}`} htmlFor="preferredFormats"><span>유지하고 싶은 format이 있나요? <b>*</b></span><textarea id="preferredFormats" aria-invalid={showRequired && !answers.preferredFormats.trim()} value={answers.preferredFormats} onChange={(event) => updateAnswer("preferredFormats", event.target.value)} placeholder="예: 표지는 짧은 한 줄, 5~7장 정도의 카드뉴스, 비속어는 사용하지 않기" maxLength={500} /><small className={showRequired && !answers.preferredFormats.trim() ? "visible" : ""}>필수 항목이에요</small></label>
        {error && <div className="onboarding-error"><span>!</span>{error}</div>}
        <button className="primary-button onboarding-submit" disabled={loading} type="submit">{loading ? "브랜드 컨텍스트 만드는 중…" : "브랜드 방향 저장하기"} <span>→</span></button>
      </form>
    </div>
  </div>;
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
  return <div className="content dashboard-page"><div className="page-heading"><div><h1>좋은 콘텐츠는<br /><em>다음 장면</em>에서 시작돼요.</h1></div><div className="dashboard-heading-actions"><div className="account-actions"><button className="account-action" onClick={onEditProfile}>프로필 수정</button><button className="account-action" onClick={onSignOut}>로그아웃</button></div><div className="dashboard-actions"><a className="secondary-link" href="/analysis">Instagram 계정 분석</a><button className="primary-button compact" onClick={onNewProject}>새 게시물 만들기 <span>＋</span></button></div></div></div><div className="dashboard-grid"><div className="profile-panel"><div className="section-label">YOUR BRAND DIRECTION</div><div className="profile-quote"><span className="profile-identity">{context.accountName}(@{context.instagramHandle})</span>{context.brandSummary.replace(/^[“"]/, "").replace(/[”"]$/, "").replace(`${context.accountName}(@${context.instagramHandle})`, "")}</div><div className="profile-tags">{context.moodKeywords.slice(0, 3).map((keyword) => <span key={keyword}>{keyword}</span>)}</div><button className="text-button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>마케터·편집자 공통 컨텍스트 적용됨 ✓</button></div><div className="activity-panel"><div className="section-label">CONTENT PILLARS <span>{String(context.contentPillars.length).padStart(2, "0")}</span></div><div className="context-list">{context.contentPillars.map((pillar, index) => <div className="context-row" key={pillar}><span>{String(index + 1).padStart(2, "0")}</span><strong>{pillar}</strong></div>)}</div><button className="empty-project" onClick={onNewProject}>+ 이 방향으로 새 프로젝트 시작</button></div></div><div className="dashboard-footer"><span>CONTEXT</span><p>마케터는 훅과 아이디어 방향에, 편집자는 문장 밀도·이미지 처리·슬라이드 흐름에 이 프로필을 사용합니다.</p></div><details className="agent-context-panel"><summary>Agent Context JSON 보기</summary><p>마케터와 편집자 Agent에 전달되는 동일한 구조화 컨텍스트입니다.</p><pre>{JSON.stringify(context, null, 2)}</pre></details></div>;
}

function Brief({ brief, setBrief, files, fileError, onFiles, onRemoveFile, onReorderFiles, onDescriptionChange, onBack, onContinue, loading, error }: { brief: string; setBrief: (value: string) => void; files: UploadedAsset[]; fileError: string; onFiles: (event: ChangeEvent<HTMLInputElement>) => void; onRemoveFile: (index: number) => void; onReorderFiles: (fromIndex: number, toIndex: number) => void; onDescriptionChange: (index: number, description: string) => void; onBack: () => void; onContinue: () => void; loading: boolean; error: string }) {
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const isReady = brief.trim() && files.length > 0 && files.every((file) => file.description.trim());
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

  return <div className="content brief-screen"><div className="page-heading"><div><div className="content-kicker">NEW PROJECT / 01</div><h1>이번 이야기를<br /><em>들려주세요.</em></h1><p className="heading-description">게시물의 전체 방향을 적고, 사진마다 그 순간의 정보를 덧붙여주세요.</p></div><div className="progress-copy">01 <span>/</span> 02<br /><small>PROJECT BRIEF</small></div></div><div className="story-brief-card"><div className="section-label">POST DIRECTION <span>REQUIRED</span></div><label htmlFor="brief">1. 이번 게시물은 어떤 이야기인가요?</label><textarea id="brief" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="예: 이번에 3박 4일 강릉 여행을 다녀왔어요. 여행의 흐름이 보이도록 일차별로 나누어 만들어주세요." /><div className="brief-hint">여행 기간, 주제, 원하는 구성처럼 게시물 전체를 설명하는 내용을 자세하게 적을수록 더 멋진 게시물이 나온답니다.</div></div><section className="asset-section"><div className="asset-section-heading"><div><div className="section-label">YOUR ASSETS <span>{files.length ? `${files.length} FILES` : "UP TO 30 FILES"}</span></div><h2>2. 사진마다 이야기를 더해주세요.</h2><p>장소, 날짜, 메뉴, 기억에 남은 점처럼 사진만으로 알 수 없는 정보를 적어주세요.</p></div><label className="asset-add-button"><input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple onChange={onFiles} /><span>＋</span> 사진 추가</label></div>{fileError && <div className="asset-upload-error" role="alert">{fileError}</div>}{files.length === 0 ? <label className="upload-zone story-upload-zone"><input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple onChange={onFiles} /><div className="upload-icon">↑</div><strong>사진을 여기에 놓거나 클릭하세요</strong><span>JPG, JPEG, PNG, WEBP · 장당 최대 20MB · 최대 30장</span></label> : <><div className="asset-carousel" ref={carouselRef}><button className="asset-carousel-arrow previous" type="button" aria-label="이전 사진" disabled={safeAssetIndex === 0} onClick={() => setActiveAssetId(files[Math.max(0, safeAssetIndex - 1)]?.id ?? null)}>‹</button><div className="asset-carousel-track" ref={trackRef}>{files.map((file, index) => { const isActive = index === safeAssetIndex; return <div className={`asset-carousel-slide ${isActive ? "active" : ""} ${dragOverIndex === index ? "drag-over" : ""}`} key={file.id} ref={(el) => { if (el) slideRefs.current.set(file.id, el); else slideRefs.current.delete(file.id); }} role="button" tabIndex={0} onClick={() => setActiveAssetId(file.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveAssetId(file.id); } }} onDragOver={(event) => { if (dragIndexRef.current === null) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDragOverIndex(index); }} onDragLeave={() => setDragOverIndex((current) => (current === index ? null : current))} onDrop={(event) => { event.preventDefault(); const from = dragIndexRef.current; dragIndexRef.current = null; setDragOverIndex(null); if (from === null || from === index) return; onReorderFiles(from, index); }} aria-label={`${index + 1}번째 사진 보기`}><img src={file.previewUrl} alt={`${index + 1}번째 업로드 사진: ${file.name}`} onLoad={centerActiveSlide} /><span>{String(index + 1).padStart(2, "0")}</span><button type="button" className="asset-carousel-slide-delete" onClick={(event) => { event.stopPropagation(); removeFileAt(index); }} aria-label={`${index + 1}번째 사진 삭제`} /><button type="button" className="asset-carousel-slide-handle" draggable onClick={(event) => event.stopPropagation()} onDragStart={(event) => { dragIndexRef.current = index; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }} onDragEnd={() => { dragIndexRef.current = null; setDragOverIndex(null); }} aria-label={`${index + 1}번째 사진 순서 변경`}>≡</button></div>; })}</div><button className="asset-carousel-arrow next" type="button" aria-label="다음 사진" disabled={safeAssetIndex === files.length - 1} onClick={() => setActiveAssetId(files[Math.min(files.length - 1, safeAssetIndex + 1)]?.id ?? null)}>›</button></div><div className="asset-carousel-progress"><span>{safeAssetIndex + 1} / {files.length}</span><div>{files.map((file, index) => <button className={index === safeAssetIndex ? "active" : ""} type="button" key={file.id} onClick={() => setActiveAssetId(file.id)} aria-label={`${index + 1}번째 사진으로 이동`} />)}</div></div>{activeAsset && <div className="active-asset-description"><div className="active-asset-heading"><div><span>PHOTO {String(safeAssetIndex + 1).padStart(2, "0")}</span><strong>이 사진에 대해 알려주세요</strong></div></div><textarea id={`asset-description-${activeAsset.id}`} value={activeAsset.description} onChange={(event) => onDescriptionChange(safeAssetIndex, event.target.value)} placeholder="예: 여행 2일차에 한짬뽕에 갔어요. 고기짬뽕이 정말 맛있었고 점심에는 20분 정도 기다렸어요." /></div>}</>}</section><div className="brief-footer"><button className="secondary-button" onClick={onBack}>← 이전</button><div>{error && <span className="asset-upload-error">{error}</span>}<button className="primary-button" disabled={!isReady || loading} onClick={onContinue}>{loading ? "분석 중…" : "아이디어 받아보기"} <b>→</b></button></div></div></div>;
}

function Ideas({ ideas, loading, error, selectedIdea, onSelect, onBack, onContinue }: { ideas: Idea[]; loading: boolean; error: string; selectedIdea: Idea | null; onSelect: (idea: Idea) => void; onBack: () => void; onContinue: () => void }) {
  return (
    <div className="content ideas-screen">
      <div className="page-heading">
        <div>
          <div className="content-kicker">CONTENT DIRECTION / 02</div>
          <h1>두 가지 방향을<br /><em>준비했어요.</em></h1>
          <p className="heading-description">같은 사진도 어떤 시선으로 묶느냐에 따라 전혀 다른 브랜드 경험이 됩니다.</p>
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
            </div>
          </div>
        ) : (
          ideas.map((idea) => (
            <button className={`idea-card ${selectedIdea?.id === idea.id ? "selected" : ""}`} key={idea.id} onClick={() => onSelect(idea)}>
              <div className={`idea-visual ${idea.accent}`}><div className="visual-noise" /><span>{idea.id === "guide" ? "A GUIDE\nTO GANGNEUNG" : "NOTES FROM\nGANGNEUNG"}</span><i>✦</i></div>
              <div className="idea-card-body">
                <div className="idea-label">{idea.label}</div>
                <h2>{idea.title}</h2>
                <p>{idea.description}</p>
                <div className="idea-meta"><span>{idea.format}</span><span>{idea.assets.join(" · ")}</span></div>
              </div>
              <div className="select-mark">{selectedIdea?.id === idea.id ? "✓" : "○"}</div>
            </button>
          ))
        )}
      </div>
      <div className="idea-footer">
        <button className="secondary-button" onClick={onBack}>← 요청 수정</button>
        <button className="primary-button" disabled={!selectedIdea || loading} onClick={onContinue}>이 방향으로 제작하기 <span>→</span></button>
      </div>
    </div>
  );
}

function Review({ post, instagramHandle, activeSlide, setActiveSlide, onBack, onRestart }: { post: RenderedPost; instagramHandle: string; activeSlide: number; setActiveSlide: (value: number) => void; onBack: () => void; onRestart: () => void }) {
  const slide = post.slides[activeSlide];
  const previewImage = post.previewImageUrl ? <img className="agent-rendered-image" src={post.previewImageUrl} alt="편집자 에이전트 결과" /> : null;
  return <div className="content review-screen"><div className="page-heading"><div><div className="content-kicker">EDITOR AGENT / 03</div><h1>첫 번째 게시물이<br /><em>완성됐어요.</em></h1><p className="heading-description">마음에 드는지 천천히 살펴보고, 필요한 부분만 다듬어보세요.</p></div><div className="render-status"><span className="status-orb green" /> READY TO REVIEW</div></div><div className="review-grid"><div className={`post-preview ${slide.gradient} ${post.previewImageUrl ? "agent-rendered" : ""}`}>{previewImage}<div className="preview-top"><span>BMT</span><span>{slide.eyebrow}</span></div><div className="preview-content"><div className="preview-eyebrow">{slide.eyebrow}</div><h2>{slide.title}</h2><p>{slide.copy}</p></div><div className="preview-bottom"><span>@{instagramHandle}</span><span>✦</span></div></div><div className="review-info"><div className="section-label">CAROUSEL PREVIEW <span>{activeSlide + 1} / {post.slides.length}</span></div><div className="slide-strip">{post.slides.map((item, index) => <button className={index === activeSlide ? "active" : ""} key={`${item.title}-${index}`} onClick={() => setActiveSlide(index)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong></button>)}</div><div className="caption-box"><div className="section-label">CAPTION</div><p>{post.caption}</p></div><div className="button-row"><button className="secondary-button" onClick={onBack}>← 아이디어 변경</button><button className="primary-button" onClick={() => window.alert("다운로드 준비가 완료됐어요. (MVP Mock)")}>게시물 다운로드 <span>↓</span></button></div><button className="regenerate-button" onClick={onRestart}>↻ 새로운 게시물 만들기</button></div></div></div>;
}
