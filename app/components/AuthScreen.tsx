"use client";

import { FormEvent, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

type AuthMode = "sign-in" | "sign-up";

export function AuthScreen({ supabase }: { supabase: SupabaseClient | null }) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");

    if (!supabase) {
      setError("Supabase 환경 변수가 설정되지 않았어요.");
      return;
    }

    setLoading(true);
    const result = mode === "sign-in"
      ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
      : await supabase.auth.signUp({ email: email.trim(), password });
    setLoading(false);

    if (result.error) {
      setError(result.error.message);
      return;
    }

    if (mode === "sign-up" && !result.data.session) {
      setMessage("가입 확인 메일을 보냈어요. 이메일을 확인해주세요.");
    }
  }

  const isSignIn = mode === "sign-in";

  return (
    <main className="auth-shell">
      <div className="auth-grid">
        <div className="auth-intro">
          <div className="brand-mark auth-brand"><span>NOMORE</span><b>BMT</b></div>
          <h1 id="auth-title">당신의 이야기가<br /><span className="intro-highlight-line"><em>브랜드</em>가 되는 순간</span></h1>
          <p>로그인하면 브랜드 방향과 콘텐츠 작업을 안전하게 이어갈 수 있어요.</p>
        </div>

        <section className="auth-card" aria-labelledby="auth-title">
          <h2>{isSignIn ? "다시 만나서 반가워요." : "새로운 이야기를 시작해요."}</h2>

          <form className="auth-form" onSubmit={submit}>
          <label htmlFor="auth-email">이메일</label>
          <input
            id="auth-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
          <label htmlFor="auth-password">비밀번호</label>
          <input
            id="auth-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="6자 이상 입력해주세요"
            autoComplete={isSignIn ? "current-password" : "new-password"}
            minLength={6}
            required
          />
          {error && <div className="auth-message error" role="alert">{error}</div>}
          {message && <div className="auth-message success" role="status">{message}</div>}
          <button className="primary-button auth-submit" type="submit" disabled={loading}>
            {loading ? "처리 중…" : isSignIn ? "로그인" : "계정 만들기"}
            <span>→</span>
          </button>
          </form>

          <div className="auth-switch-row">
            <span>{isSignIn ? "계정이 없나요?" : "이미 계정이 있나요?"}</span>
            <button
              className="auth-switch"
              type="button"
              onClick={() => {
                setMode(isSignIn ? "sign-up" : "sign-in");
                setError("");
                setMessage("");
              }}
            >
              {isSignIn ? "회원가입" : "로그인"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
