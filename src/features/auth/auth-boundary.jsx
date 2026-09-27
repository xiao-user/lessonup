import { useEffect, useState } from "react";
import { LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { restoreSession, signIn as signInWithPassword } from "@/lib/session";

export function AuthBoundary({ children }) {
  const [session, setSession] = useState(undefined);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    let active = true;
    const refresh = () => { void restoreSession().then((nextSession) => { if (active) setSession(nextSession); }); };
    refresh();
    window.addEventListener("lessonup-session-change", refresh);
    return () => {
      active = false;
      window.removeEventListener("lessonup-session-change", refresh);
    };
  }, []);

  if (session) return children;
  if (session === undefined) return null;

  const signIn = async (event) => {
    event.preventDefault();
    if (!account.trim() || !password) return;
    setStatus("sending");
    try {
      const nextSession = await signInWithPassword(account, password);
      setSession(nextSession);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
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
        {status === "error" && <small role="alert">账号或密码错误，请重试。</small>}
      </form>
    </main>
  );
}
