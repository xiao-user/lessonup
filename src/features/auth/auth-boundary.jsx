import { useEffect, useState } from "react";
import { Mail } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";

export function AuthBoundary({ children }) {
  const [session, setSession] = useState(undefined);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    if (!supabase) {
      setSession(null);
      return undefined;
    }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const token = session?.access_token;
    if (token) window.localStorage.setItem("lessonup:access-token", token);
    else window.localStorage.removeItem("lessonup:access-token");
  }, [session]);

  if (!supabase || session) return children;
  if (session === undefined) return null;

  const requestMagicLink = async (event) => {
    event.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setStatus(error ? "error" : "sent");
  };

  return (
    <main className="auth-stage">
      <form className="auth-form" onSubmit={requestMagicLink}>
        <span className="auth-mark"><Mail /></span>
        <h1>进入 LessonUp</h1>
        <p>使用邮箱验证码登录。备课本、会话与资料将按你的身份隔离。</p>
        <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="teacher@example.com" aria-label="邮箱" autoComplete="email" />
        <Button type="submit" disabled={!email.trim() || status === "sending"}>{status === "sending" ? "正在发送…" : "发送登录链接"}</Button>
        {status === "sent" && <small>登录链接已发送，请返回此页面继续。</small>}
        {status === "error" && <small role="alert">发送失败，请检查邮箱后重试。</small>}
      </form>
    </main>
  );
}
