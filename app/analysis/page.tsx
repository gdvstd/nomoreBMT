"use client";

import { useEffect, useMemo, useState } from "react";
import type { EditorAgentContext } from "@/lib/marketing-context";

type ConfigResponse = {
  configured: { instagram: boolean; openai: boolean };
  defaults: {
    postLimit: number;
    commentsPerPost: number;
    instagramApiVersion: string;
    openaiModel: string;
  };
};

type AnalysisResponse = {
  context?: EditorAgentContext;
  error?: string;
  detail?: string;
};

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

export default function InstagramAnalysisPage() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [postLimit, setPostLimit] = useState(12);
  const [commentsPerPost, setCommentsPerPost] = useState(20);
  const [focus, setFocus] = useState("");
  const [context, setContext] = useState<EditorAgentContext | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/instagram/analyze", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: ConfigResponse) => {
        setConfig(data);
        setPostLimit(data.defaults.postLimit);
        setCommentsPerPost(data.defaults.commentsPerPost);
      })
      .catch(() => setError("설정 상태를 확인하지 못했습니다."));
  }, []);

  const ready = Boolean(config?.configured.instagram && config?.configured.openai);
  const json = useMemo(() => (context ? JSON.stringify(context, null, 2) : ""), [context]);

  async function runAnalysis() {
    setLoading(true);
    setError("");
    setContext(null);

    try {
      const response = await fetch("/api/instagram/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postLimit, commentsPerPost, focus }),
      });
      const data = (await response.json()) as AnalysisResponse;
      if (!response.ok || !data.context) {
        throw new Error([data.error, data.detail].filter(Boolean).join(" "));
      }
      setContext(data.context);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "분석에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  function downloadContext() {
    if (!json || !context) return;
    const blob = new Blob([json], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${context.account.username}-editor-context.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="analysis-shell">
      <header className="analysis-header">
        <a href="/" className="analysis-brand"><span>B</span> BMT</a>
        <a href="/" className="analysis-back">← 제작 화면으로</a>
      </header>

      <section className="analysis-hero">
        <div>
          <div className="content-kicker">INSTAGRAM CONTEXT MODEL / MVP</div>
          <h1>기존 반응을 읽고,<br /><em>다음 편집의 기준</em>을 만듭니다.</h1>
          <p>
            게시물 성과와 댓글을 수집해 정량 baseline을 계산하고,
            편집자 Agent가 바로 사용할 수 있는 근거 중심 JSON으로 변환합니다.
          </p>
        </div>
        <div className="analysis-status-card">
          <div className="section-label">CONNECTION STATUS</div>
          <div className={`connection-row ${config?.configured.instagram ? "ok" : ""}`}>
            <span /> Instagram API
            <b>{config?.configured.instagram ? "READY" : "MISSING"}</b>
          </div>
          <div className={`connection-row ${config?.configured.openai ? "ok" : ""}`}>
            <span /> OpenAI API
            <b>{config?.configured.openai ? "READY" : "MISSING"}</b>
          </div>
          {config && (
            <small>{config.defaults.instagramApiVersion} · {config.defaults.openaiModel}</small>
          )}
        </div>
      </section>

      <section className="analysis-control">
        <div className="analysis-control-grid">
          <label>
            <span>분석할 최근 게시물</span>
            <input type="number" min={1} max={30} value={postLimit}
              onChange={(event) => setPostLimit(Number(event.target.value))} />
          </label>
          <label>
            <span>게시물당 댓글</span>
            <input type="number" min={0} max={50} value={commentsPerPost}
              onChange={(event) => setCommentsPerPost(Number(event.target.value))} />
          </label>
          <label className="analysis-focus">
            <span>분석 초점 (선택)</span>
            <textarea value={focus} onChange={(event) => setFocus(event.target.value)}
              placeholder="예: 저장과 공유를 높이는 carousel 편집 원칙을 중심으로 분석" />
          </label>
        </div>
        <button className="primary-button analysis-run" disabled={!ready || loading} onClick={runAnalysis}>
          {loading ? "게시물과 반응을 분석하는 중…" : "편집자 Context 생성"} <span>→</span>
        </button>
        <p className="analysis-note">
          MVP에서는 최근 게시물 최대 30개, 게시물당 댓글 최대 50개를 분석합니다.
        </p>
        {error && <div className="analysis-error">{error}</div>}
      </section>

      {context && (
        <section className="analysis-result">
          <div className="result-heading">
            <div>
              <div className="content-kicker">CONTEXT READY</div>
              <h2>@{context.account.username} 분석 결과</h2>
              <p>{context.analysis.performanceSummary.overview}</p>
            </div>
            <button className="primary-button" onClick={downloadContext}>
              JSON 다운로드 <span>↓</span>
            </button>
          </div>

          <div className="metric-grid">
            <Metric label="POSTS" value={String(context.coverage.analyzedPostCount)} />
            <Metric label="IMAGES" value={String(context.coverage.analyzedImageCount)} />
            <Metric label="COMMENTS" value={String(context.coverage.analyzedCommentCount)} />
            <Metric label="MEDIAN LIKES" value={String(context.baseline.medianLikes)} />
            <Metric label="SAVE RATE" value={percent(context.baseline.medianSaveRate)} />
            <Metric label="SHARE RATE" value={percent(context.baseline.medianShareRate)} />
          </div>

          <div className="analysis-result-grid">
            <ResultList eyebrow="PROVEN PATTERNS" title="계속 활용할 패턴"
              items={context.analysis.performanceSummary.winningPatterns.map(
                (item) => `${item.finding} · 신뢰도 ${Math.round(item.confidence * 100)}%`,
              )} tone="positive" />
            <ResultList eyebrow="WEAK PATTERNS" title="수정하거나 검증할 패턴"
              items={context.analysis.performanceSummary.weakPatterns.map(
                (item) => `${item.finding} · 신뢰도 ${Math.round(item.confidence * 100)}%`,
              )} tone="negative" />
            <ResultList eyebrow="AUDIENCE SIGNALS" title="댓글에서 읽힌 반응"
              items={[
                ...context.analysis.audienceResponse.likedAspects,
                ...context.analysis.audienceResponse.repeatedQuestions.map(
                  (item) => `반복 질문: ${item}`,
                ),
              ]} />
            <ResultList eyebrow="EDITOR HANDOFF" title="편집자 Agent 실행 원칙"
              items={context.analysis.editorContext.creativePrinciples} tone="editor" />
            <ResultList eyebrow="VISUAL PRIORITY" title="카드뉴스 우선 수정사항"
              items={context.analysis.visualAnalysis.priorityFixes} tone="negative" />
          </div>

          <details className="context-json">
            <summary>전체 Editor Context JSON 보기</summary>
            <pre>{json}</pre>
          </details>
        </section>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-card"><span>{label}</span><strong>{value}</strong></div>;
}

function ResultList({
  eyebrow,
  title,
  items,
  tone = "",
}: {
  eyebrow: string;
  title: string;
  items: string[];
  tone?: string;
}) {
  return (
    <article className={`result-card ${tone}`}>
      <div className="section-label">{eyebrow}</div>
      <h3>{title}</h3>
      {items.length ? (
        <ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
      ) : (
        <p>현재 데이터에서 충분한 근거를 찾지 못했습니다.</p>
      )}
    </article>
  );
}
