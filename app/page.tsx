"use client";

import { ChangeEvent, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { mockIdeas, renderMockPost } from "@/lib/mock-agents";
import type { Idea, RenderedPost, Screen } from "@/lib/types";

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

export default function Home() {
  const [screen, setScreen] = useState<Screen>("onboarding");
  const [brandText, setBrandText] = useState("");
  const [brief, setBrief] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [renderedPost, setRenderedPost] = useState<RenderedPost | null>(null);
  const [activeSlide, setActiveSlide] = useState(0);

  const currentStep = steps.findIndex((step) => step.id === screen);
  const profileSummary = useMemo(() => {
    if (!brandText) return "아직 브랜드 방향을 입력하지 않았어요";
    return brandText.length > 52 ? `${brandText.slice(0, 52)}…` : brandText;
  }, [brandText]);

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []).map((file) => file.name);
    setFiles((previous) => [...previous, ...selected].slice(0, 30));
  }

  function removeFile(index: number) {
    setFiles((previous) => previous.filter((_, fileIndex) => fileIndex !== index));
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
          <Brief brief={brief} setBrief={setBrief} files={files} onFiles={handleFiles} onRemoveFile={removeFile} onBack={() => setScreen("dashboard")} onContinue={() => setScreen("ideas")} />
        )}

        {screen === "ideas" && (
          <Ideas selectedIdea={selectedIdea} onSelect={chooseIdea} onBack={() => setScreen("brief")} onContinue={createPost} />
        )}

        {screen === "editor" && selectedIdea && (
          <EditorPlaneMount idea={selectedIdea} onBack={() => setScreen("ideas")} onFinish={() => setScreen("review")} />
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

function Brief({ brief, setBrief, files, onFiles, onRemoveFile, onBack, onContinue }: { brief: string; setBrief: (value: string) => void; files: string[]; onFiles: (event: ChangeEvent<HTMLInputElement>) => void; onRemoveFile: (index: number) => void; onBack: () => void; onContinue: () => void }) {
  return <div className="content brief-screen"><div className="page-heading"><div><div className="content-kicker">NEW PROJECT / 01</div><h1>무엇을<br /><em>만들어볼까요?</em></h1><p className="heading-description">사진을 올리고, 이번 게시물에서 전하고 싶은 이야기를 알려주세요.</p></div><div className="progress-copy">01 <span>/</span> 02<br /><small>PROJECT BRIEF</small></div></div><div className="brief-grid"><div className="upload-card"><div className="section-label">YOUR ASSETS <span>{files.length ? `${files.length} FILES` : "UP TO 30 FILES"}</span></div><label className="upload-zone"><input type="file" accept="image/*" multiple onChange={onFiles} /><div className="upload-icon">↑</div><strong>사진을 여기에 놓거나 클릭하세요</strong><span>JPG, PNG · 사진은 비공개로 안전하게 보관됩니다</span></label>{files.length > 0 && <div className="file-list">{files.map((file, index) => <div className="file-row" key={`${file}-${index}`}><span className="file-thumb">{String(index + 1).padStart(2, "0")}</span><span>{file}</span><button onClick={() => onRemoveFile(index)} aria-label={`${file} 제거`}>×</button></div>)}</div>}</div><div className="brief-form"><div className="section-label">THE BRIEF</div><label htmlFor="brief">이번 게시물로 무엇을 전하고 싶나요?</label><textarea id="brief" value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="예: 강릉에서 다녀온 맛집들을 추천하는 저장용 캐러셀을 만들어줘. 사진의 따뜻한 분위기는 살리고, 정보도 한눈에 들어오게 해줘." /><div className="brief-hint"><span>✦</span> 장소명, 제품명, 반드시 넣을 정보를 함께 적어주면 더 좋아요.</div><div className="button-row"><button className="secondary-button" onClick={onBack}>← 이전</button><button className="primary-button" disabled={!brief.trim() || files.length === 0} onClick={onContinue}>아이디어 받아보기 <span>→</span></button></div></div></div></div>;
}

function Ideas({ selectedIdea, onSelect, onBack, onContinue }: { selectedIdea: Idea | null; onSelect: (idea: Idea) => void; onBack: () => void; onContinue: () => void }) {
  return <div className="content ideas-screen"><div className="page-heading"><div><div className="content-kicker">MARKETER AGENT / 02</div><h1>두 가지 방향을<br /><em>준비했어요.</em></h1><p className="heading-description">같은 사진도 어떤 시선으로 묶느냐에 따라 전혀 다른 브랜드 경험이 됩니다.</p></div><div className="agent-status"><span className="status-orb" /> MARKETER AGENT<br /><small>2 IDEAS READY</small></div></div><div className="idea-grid">{mockIdeas.map((idea) => <button className={`idea-card ${selectedIdea?.id === idea.id ? "selected" : ""}`} key={idea.id} onClick={() => onSelect(idea)}><div className={`idea-visual ${idea.accent}`}><div className="visual-noise" /><span>{idea.id === "guide" ? "A GUIDE\nTO GANGNEUNG" : "NOTES FROM\nGANGNEUNG"}</span><i>✦</i></div><div className="idea-card-body"><div className="idea-label">{idea.label}</div><h2>{idea.title}</h2><p>{idea.description}</p><div className="idea-meta"><span>{idea.format}</span><span>{idea.assets.join(" · ")}</span></div></div><div className="select-mark">{selectedIdea?.id === idea.id ? "✓" : "○"}</div></button>)}</div><div className="idea-footer"><button className="secondary-button" onClick={onBack}>← 요청 수정</button><button className="primary-button" disabled={!selectedIdea} onClick={onContinue}>이 방향으로 제작하기 <span>→</span></button></div></div>;
}

function Review({ post, activeSlide, setActiveSlide, onBack, onRestart }: { post: RenderedPost; activeSlide: number; setActiveSlide: (value: number) => void; onBack: () => void; onRestart: () => void }) {
  const slide = post.slides[activeSlide];
  return <div className="content review-screen"><div className="page-heading"><div><div className="content-kicker">EDITOR AGENT / 03</div><h1>첫 번째 게시물이<br /><em>완성됐어요.</em></h1><p className="heading-description">마음에 드는지 천천히 살펴보고, 필요한 부분만 다듬어보세요.</p></div><div className="render-status"><span className="status-orb green" /> READY TO REVIEW</div></div><div className="review-grid"><div className={`post-preview ${slide.gradient}`}><div className="preview-top"><span>BMT</span><span>{slide.eyebrow}</span></div><div className="preview-content"><div className="preview-eyebrow">{slide.eyebrow}</div><h2>{slide.title}</h2><p>{slide.copy}</p></div><div className="preview-bottom"><span>seoyeon.studio</span><span>✦</span></div></div><div className="review-info"><div className="section-label">CAROUSEL PREVIEW <span>{activeSlide + 1} / {post.slides.length}</span></div><div className="slide-strip">{post.slides.map((item, index) => <button className={index === activeSlide ? "active" : ""} key={`${item.title}-${index}`} onClick={() => setActiveSlide(index)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong></button>)}</div><div className="caption-box"><div className="section-label">CAPTION</div><p>{post.caption}</p></div><div className="button-row"><button className="secondary-button" onClick={onBack}>← 아이디어 변경</button><button className="primary-button" onClick={() => window.alert("다운로드 준비가 완료됐어요. (MVP Mock)")}>게시물 다운로드 <span>↓</span></button></div><button className="regenerate-button" onClick={onRestart}>↻ 새로운 게시물 만들기</button></div></div></div>;
}
