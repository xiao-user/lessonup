import { useEffect, useState } from "react";
import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";

export function AuthBoundary({ children }) {
  const [session, setSession] = useState(undefined);
  const [account, setAccount] = useState(import.meta.env.DEV ? "admin" : "");
  const [password, setPassword] = useState(import.meta.env.DEV ? "1234" : "");
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

  if (!supabase || session) return children;
  if (session === undefined) return null;

  const signIn = async (event) => {
    event.preventDefault();
    if (!account.trim() || !password) return;
    setStatus("sending");
    const normalizedAccount = account.trim().toLowerCase();
    const email = normalizedAccount.includes("@")
      ? normalizedAccount
      : `${normalizedAccount}@lessonup.local`;
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setStatus(error ? "error" : "idle");
  };

  return (
    <main className="auth-stage">
      <form className="auth-form" onSubmit={signIn}>
        <span className="auth-mark"><LogIn /></span>
        <h1>进入 LessonUp</h1>
        <p>使用账号密码登录。备课本、会话与资料将按你的身份隔离。</p>
        <Input
          value={account}
          onChange={(event) => setAccount(event.target.value)}
          placeholder="账号"
          aria-label="账号"
          autoComplete="username"
        />
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="密码"
          aria-label="密码"
          autoComplete="current-password"
        />
        <Button type="submit" disabled={!account.trim() || !password || status === "sending"}>
          {status === "sending" ? "正在登录…" : "登录"}
        </Button>
        {import.meta.env.DEV && <small>本地测试账号：admin　密码：1234</small>}
        {status === "error" && <small role="alert">账号或密码错误，请重试。</small>}
      </form>
    </main>
  );
}
