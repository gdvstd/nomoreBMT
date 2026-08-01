"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { mockIdeas } from "@/lib/mock-agents";
import type { EditorPlaneResult, Idea, RenderedPost, Screen } from "@/lib/types";

type UploadedAsset = {
  id: string;
  name: string;
  previewUrl: string;
  description: string;
  dataUrl: string;
};

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;


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
  const [screen, setScreen] = useState<Screen>("onboarding");
  const [brandText, setBrandText] = useState("");
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

  useEffect(() => () => {
    marketerStream.current?.close();
  }, []);

  const currentStep = steps.findIndex((step) => step.id === screen);
  const profileSummary = useMemo(() => {
    if (!brandText) return "아직 브랜드 방향을 입력하지 않았어요";
    return brandText.length > 52 ? `${brandText.slice(0, 52)}…` : brandText;
  }, [brandText]);

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
      setFileError("이미지 한 장의 크기는 20MB 이하여야 해요.");
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
      combined.slice(30).forEach((file) => URL.revokeObjectURL(file.previewUrl));
      return combined.slice(0, 30);
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

  function chooseIdea(idea: Idea) {
    setSelectedIdea(idea);
    setRenderedPost(null);
  }

  function createPost() {
    if (!selectedIdea) return;
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

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark"><span>B</span> BMT</div>
        <div className="brand-subtitle">BRAND MOTION TOOLKIT</div>

        <div className="sidebar-block">
          <div className="eyebrow">YOUR WORKSPACE</div>
          <div className="workspace-card">
            <div className="workspace-avatar">S</div>
            <div><strong>seoyeon.studio</strong><span>Personal brand</span></div>
            <span className="chevron">⌄</span>
          </div>
        </div>

        <nav className="step-nav" aria-label="제작 단계">
          {steps.map((step, index) => {
            const isCurrent = step.id === screen;
            const isDone = index < currentStep;
            return (
              <button className={`step-item ${isCurrent ? "current" : ""} ${isDone ? "done" : ""}`} key={step.id} onClick={() => index <= currentStep && setScreen(step.id)}>
                <span className="step-number">{isDone ? "✓" : step.number}</span>
                <span>{step.label}</span>
                {isCurrent && <span className="step-dot" />}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="mini-label">BRAND NOTE</div>
          <p>{profileSummary}</p>
          <button className="quiet-button" onClick={() => setScreen("onboarding")}>브랜드 프로필 수정 <span>↗</span></button>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>WORKSPACE</span><b>/</b><strong>{screen === "onboarding" ? "ONBOARDING" : screen === "editor" ? "EDITOR PLANE" : "NEW PROJECT"}</strong></div>
          <div className="topbar-actions"><button className="help-button">? <span>도움말</span></button><div className="profile-chip">SY</div></div>
        </header>

        {screen === "onboarding" && (
          <Onboarding brandText={brandText} setBrandText={setBrandText} onContinue={() => setScreen("dashboard")} />
        )}

        {screen === "dashboard" && (
          <Dashboard brandText={brandText} onNewProject={() => setScreen("brief")} />
        )}

        {screen === "brief" && (
          <Brief brief={brief} setBrief={setBrief} files={files} fileError={fileError} onFiles={handleFiles} onRemoveFile={removeFile} onDescriptionChange={updateFileDescription} onBack={() => setScreen("dashboard")} onContinue={generateIdeas} loading={ideasLoading} error={ideasError} />
        )}

        {screen === "ideas" && (
          <Ideas ideas={ideas} loading={ideasLoading} error={ideasError} currentReasoning={ideasCurrentReasoning} recentTool={ideasRecentTool} eventLog={ideasEventLog} streamText={ideasStreamText} traceId={ideasTraceId} selectedIdea={selectedIdea} onSelect={chooseIdea} onBack={() => setScreen("brief")} onContinue={createPost} />
        )}

        {screen === "editor" && selectedIdea && (
          <EditorPlaneMount idea={selectedIdea} task={brief} brandText={brandText} assetItems={files} onBack={() => setScreen("ideas")} onFinish={(result: EditorPlaneResult) => {
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
            });
            setActiveSlide(0);
            setScreen("review");
          }} />
        )}

        {screen === "review" && renderedPost && (
          <Review post={renderedPost} activeSlide={activeSlide} setActiveSlide={setActiveSlide} onBack={() => setScreen("editor")} onRestart={() => { setRenderedPost(null); setScreen("brief"); }} />
        )}
      </section>
    </main>
  );
}

function Onboarding({ brandText, setBrandText, onContinue }: { brandText: string; setBrandText: (value: string) => void; onContinue: () => void }) {
  return <div className="content onboarding-screen">
    <div className="content-kicker">WELCOME TO BMT <span>✦</span></div>
    <div className="onboarding-grid">
      <div className="intro-copy"><h1>당신의 이야기가<br /><em>브랜드</em>가 되는 곳.</h1><p>사진과 말로 당신다운 방향을 알려주세요. BMT가 다음 콘텐츠의 첫 구조를 함께 만듭니다.</p><div className="intro-note"><span>✦</span><div><strong>한 문장보다, 한 장면처럼</strong><p>완벽한 답을 준비할 필요 없어요. 지금 떠오르는 말 그대로 적어주세요.</p></div></div></div>
      <div className="form-card"><div className="form-card-top"><span className="card-index">01</span><span className="required">REQUIRED</span></div><label htmlFor="brand">나를 어떤 브랜드로 기억하게 하고 싶나요?</label><textarea id="brand" value={brandText} onChange={(event) => setBrandText(event.target.value)} placeholder="예: 저는 국내 소도시 여행과 맛집을 소개해요. 과장되지 않고, 친구가 추천해주는 듯한 따뜻한 분위기를 만들고 싶어요." /><div className="character-count">{brandText.length} / 500</div><button className="primary-button" disabled={!brandText.trim()} onClick={onContinue}>브랜드 방향 저장하기 <span>→</span></button></div>
    </div>
  </div>;
}

function Dashboard({ brandText, onNewProject }: { brandText: string; onNewProject: () => void }) {
  return <div className="content"><div className="page-heading"><div><div className="content-kicker">WORKSPACE / OVERVIEW</div><h1>좋은 콘텐츠는<br /><em>다음 장면</em>에서 시작돼요.</h1></div><div className="dashboard-actions"><a className="secondary-link" href="/analysis">Instagram 계정 분석</a><button className="primary-button compact" onClick={onNewProject}>새 게시물 만들기 <span>＋</span></button></div></div><div className="dashboard-grid"><div className="profile-panel"><div className="section-label">YOUR BRAND DIRECTION</div><div className="profile-quote">“{brandText}”</div><div className="profile-tags"><span>여행</span><span>맛집</span><span>따뜻한 톤</span></div><button className="text-button">프로필 자세히 보기 →</button></div><div className="activity-panel"><div className="section-label">RECENT PROJECTS <span>01</span></div><div className="project-row"><div className="project-art art-coast"><span>강릉</span></div><div className="project-info"><strong>강릉 미식 여행</strong><span>아이디어 선택 대기 중 · 오늘</span></div><span className="status-pill">DRAFT</span></div><button className="empty-project" onClick={onNewProject}>+ 새 프로젝트 시작</button></div></div><div className="dashboard-footer"><span>TIP</span><p>사진이 많을수록 좋아요. 한 번의 여행에서 발견한 장면을 한꺼번에 올려보세요.</p></div></div>;
}

function Brief({ brief, setBrief, files, fileError, onFiles, onRemoveFile, onDescriptionChange, onBack, onContinue, loading, error }: { brief: string; setBrief: (value: string) => void; files: UploadedAsset[]; fileError: string; onFiles: (event: ChangeEvent<HTMLInputElement>) => void; onRemoveFile: (index: number) => void; onDescriptionChange: (index: number, description: string) => void; onBack: () => void; onContinue: () => void; loading: boolean; error: string }) {
  const [activeAssetIndex, setActiveAssetIndex] = useState(0);
  const isReady = brief.trim() && files.length > 0 && files.every((file) => file.description.trim());
  const safeAssetIndex = Math.min(activeAssetIndex, Math.max(files.length - 1, 0));
  const activeAsset = files[safeAssetIndex];
  const visibleAssetIndexes = files
    .map((_, index) => index)
    .filter((index) => Math.abs(index - safeAssetIndex) <= 1);

  function removeActiveFile() {
    onRemoveFile(safeAssetIndex);
    setActiveAssetIndex((current) => Math.max(0, Math.min(current, files.length - 2)));
  }

  return <div className="content brief-screen"><div className="page-heading"><div><div className="content-kicker">NEW PROJECT / 01</div><h1>이번 이야기를<br /><em>들려주세요.</em></h1><p className="heading-description">게시물의 전체 방향을 적고, 사진마다 그 순간의 정보를 덧붙여주세요.</p></div><div className="progress-copy">01 <span>/</span> 02<br /><small>PROJECT BRIEF</small></div></div><div className="story-brief-card"><div className="section-label">POST DIRECTION <span>REQUIRED</span></div><label htmlFor="brief">이번 게시물은 어떤 이야기인가요?</label><textarea id="brief" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="예: 이번에 3박 4일 강릉 여행을 다녀왔어요. 여행의 흐름이 보이도록 일차별로 나누어 만들어주세요." /><div className="brief-hint"><span>✦</span> 여행 기간, 주제, 원하는 구성처럼 게시물 전체를 설명하는 내용을 자유롭게 적어주세요.</div></div><section className="asset-section"><div className="asset-section-heading"><div><div className="section-label">YOUR ASSETS <span>{files.length ? `${files.length} FILES` : "UP TO 30 FILES"}</span></div><h2>사진마다 이야기를 더해주세요.</h2><p>장소, 날짜, 메뉴, 기억에 남은 점처럼 사진만으로 알 수 없는 정보를 적어주세요.</p></div><label className="asset-add-button"><input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple onChange={onFiles} /><span>＋</span> 사진 추가</label></div>{fileError && <div className="asset-upload-error" role="alert">{fileError}</div>}{files.length === 0 ? <label className="upload-zone story-upload-zone"><input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple onChange={onFiles} /><div className="upload-icon">↑</div><strong>사진을 여기에 놓거나 클릭하세요</strong><span>JPG, JPEG, PNG, WEBP · 장당 최대 20MB · 최대 30장</span></label> : <><div className="asset-carousel"><button className="asset-carousel-arrow previous" type="button" aria-label="이전 사진" disabled={safeAssetIndex === 0} onClick={() => setActiveAssetIndex((index) => Math.max(0, index - 1))}>‹</button><div className="asset-carousel-track">{visibleAssetIndexes.map((index) => { const file = files[index]; const isActive = index === safeAssetIndex; return <button className={`asset-carousel-slide ${isActive ? "active" : "side"}`} type="button" key={file.id} onClick={() => setActiveAssetIndex(index)} aria-label={`${index + 1}번째 사진 보기`}><img src={file.previewUrl} alt={`${index + 1}번째 업로드 사진: ${file.name}`} /><span>{String(index + 1).padStart(2, "0")}</span></button>; })}</div><button className="asset-carousel-arrow next" type="button" aria-label="다음 사진" disabled={safeAssetIndex === files.length - 1} onClick={() => setActiveAssetIndex((index) => Math.min(files.length - 1, index + 1))}>›</button></div><div className="asset-carousel-progress"><span>{safeAssetIndex + 1} / {files.length}</span><div>{files.map((file, index) => <button className={index === safeAssetIndex ? "active" : ""} type="button" key={file.id} onClick={() => setActiveAssetIndex(index)} aria-label={`${index + 1}번째 사진으로 이동`} />)}</div></div>{activeAsset && <div className="active-asset-description"><div className="active-asset-heading"><div><span>PHOTO {String(safeAssetIndex + 1).padStart(2, "0")}</span><strong>이 사진에 대해 알려주세요</strong></div><button type="button" onClick={removeActiveFile}>사진 삭제</button></div><textarea id={`asset-description-${activeAsset.id}`} value={activeAsset.description} onChange={(event) => onDescriptionChange(safeAssetIndex, event.target.value)} placeholder="예: 여행 2일차에 남세현짬뽕에 갔어요. 고기짬뽕이 정말 맛있었고 점심에는 20분 정도 기다렸어요." /><div className="asset-file-name">{activeAsset.name}</div></div>}</>}</section><div className="brief-footer"><button className="secondary-button" onClick={onBack}>← 이전</button><div>{error && <span className="asset-upload-error">{error}</span>}<button className="primary-button" disabled={!isReady || loading} onClick={onContinue}>{loading ? "분석 중…" : "아이디어 받아보기"} <b>→</b></button></div></div></div>;
}

function Ideas({ ideas, loading, error, currentReasoning, recentTool, eventLog, streamText, traceId, selectedIdea, onSelect, onBack, onContinue }: { ideas: Idea[]; loading: boolean; error: string; currentReasoning: string; recentTool: string; eventLog: AgentLogEntry[]; streamText: string; traceId: string; selectedIdea: Idea | null; onSelect: (idea: Idea) => void; onBack: () => void; onContinue: () => void }) {
  const streamPreview = streamText.replace(/\s+/g, " ").trim().slice(-260);
  const fallbackEvent: AgentLogEntry = { id: "waiting", kind: "status", label: "run 시작 대기 중" };
  return (
    <div className="content ideas-screen">
      <div className="page-heading">
        <div>
          <div className="content-kicker">MARKETER AGENT / 02</div>
          <h1>두 가지 방향을<br /><em>준비했어요.</em></h1>
          <p className="heading-description">같은 사진도 어떤 시선으로 묶느냐에 따라 전혀 다른 브랜드 경험이 됩니다.</p>
        </div>
        <div className="agent-status">
          <span className={`status-orb ${loading ? "" : "green"}`} /> {loading ? "MARKETER AGENT / STREAMING" : "MARKETER AGENT"}
          <br />
          <small>{loading ? "ONE INFERENCE · LIVE" : "2 IDEAS READY"}</small>
          {traceId && <small title={traceId}>TRACE {traceId.slice(-10)}</small>}
        </div>
      </div>
      {error && <div className="brief-hint"><span>!</span> {error} · 현재 화면은 mock 아이디어입니다.</div>}
      <div className="idea-grid">
        {loading ? (
          <div className="idea-card idea-card-stream" aria-busy="true">
            <div className="idea-card-body">
              <div className="idea-label">MARKETING AGENT / LIVE RUN</div>
              <h2>사진을 살펴보고 있어요…</h2>
              <p>한 번의 inference로 서로 다른 두 가지 카드 아이디어를 구성하고 있습니다.</p>
              <div className="marketer-run-summary">
                <div className="marketer-run-row">
                  <span className="marketer-run-icon">✦</span>
                  <div><span className="marketer-run-label">CURRENT REASONING</span><strong>{currentReasoning}</strong></div>
                </div>
                <div className="marketer-run-row">
                  <span className="marketer-run-icon">⌁</span>
                  <div><span className="marketer-run-label">MOST RECENT TOOL</span><strong>{recentTool}</strong></div>
                </div>
              </div>
              <details className="marketer-event-details">
                <summary>전체 reasoning · tool 로그 <span>{eventLog.length}</span></summary>
                <div className="marketer-event-log">
                  {(eventLog.length ? eventLog : [fallbackEvent]).map((entry) => (
                    <div className={`marketer-event-row ${entry.kind}`} key={entry.id}>
                      <span>{entry.kind === "tool" ? "TOOL" : entry.kind === "reasoning" ? "REASONING" : "STATUS"}</span>
                      <p><strong>{entry.label}</strong>{entry.detail && <small>{entry.detail}</small>}</p>
                    </div>
                  ))}
                </div>
                {streamPreview && <div className="marketer-output-details"><div className="marketer-run-label">MODEL OUTPUT STREAM</div><pre>{streamText}</pre></div>}
              </details>
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

function Review({ post, activeSlide, setActiveSlide, onBack, onRestart }: { post: RenderedPost; activeSlide: number; setActiveSlide: (value: number) => void; onBack: () => void; onRestart: () => void }) {
  const slide = post.slides[activeSlide];
  const previewImageUrl = slide.imageDataUrl ?? post.previewImageUrl;

  function downloadSlides() {
    post.slides.forEach((item, index) => {
      if (!item.imageDataUrl) return;
      const link = document.createElement("a");
      link.href = item.imageDataUrl;
      link.download = `bmt-card-${String(index + 1).padStart(2, "0")}.png`;
      link.click();
    });
  }

  return <div className="content review-screen"><div className="page-heading"><div><div className="content-kicker">EDITOR AGENT / 03</div><h1>첫 번째 게시물이<br /><em>완성됐어요.</em></h1><p className="heading-description">마음에 드는지 천천히 살펴보고, 필요한 부분만 다듬어보세요.</p></div><div className="render-status"><span className="status-orb green" /> READY TO REVIEW</div></div><div className="review-grid"><div className={`post-preview ${slide.gradient} ${previewImageUrl ? "agent-rendered" : ""}`}>{previewImageUrl ? <img className="agent-rendered-image" src={previewImageUrl} alt={`${activeSlide + 1}번째 편집자 에이전트 결과`} /> : <><div className="preview-top"><span>BMT</span><span>{slide.eyebrow}</span></div><div className="preview-content"><div className="preview-eyebrow">{slide.eyebrow}</div><h2>{slide.title}</h2><p>{slide.copy}</p></div><div className="preview-bottom"><span>seoyeon.studio</span><span>✦</span></div></>}</div><div className="review-info"><div className="section-label">CAROUSEL PREVIEW <span>{activeSlide + 1} / {post.slides.length}</span></div><div className="slide-strip">{post.slides.map((item, index) => <button className={index === activeSlide ? "active" : ""} key={`${item.nodeId ?? item.title}-${index}`} onClick={() => setActiveSlide(index)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong></button>)}</div><div className="caption-box"><div className="section-label">CAPTION</div><p>{post.caption}</p></div><div className="button-row"><button className="secondary-button" onClick={onBack}>← 아이디어 변경</button><button className="primary-button" onClick={downloadSlides}>게시물 다운로드 <span>↓</span></button></div><button className="regenerate-button" onClick={onRestart}>↻ 새로운 게시물 만들기</button></div></div></div>;
}
