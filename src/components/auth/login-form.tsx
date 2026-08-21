"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GitBranch, KeyRound, UserRound } from "lucide-react";
import { AuthShell } from "./auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const errorMessages: Record<string, string> = {
  github_denied: "GitHub 授权已取消",
  github_no_code: "GitHub 回调缺少授权码",
  github_state_mismatch: "GitHub 登录状态验证失败，请重试",
};

export function LoginForm() {
  const router = useRouter(); const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);
  const initialError = params.get("error");
  const [error, setError] = useState<string | null>(initialError ? (errorMessages[initialError] || initialError) : null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/github/status").then((r) => r.json().catch(() => null)).then((data) => {
      if (!cancelled && data?.enabled) setGithubEnabled(true);
    }).catch(() => undefined);
    return () => { cancelled = true };
  }, []);

  function githubLogin() {
    const next = params.get("next");
    const params2 = next ? `?next=${encodeURIComponent(next)}` : "";
    window.location.href = `/api/auth/github${params2}`;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "用户名或密码错误");
      const next = params.get("next");
      router.replace(next?.startsWith("/") && !next.startsWith("//") ? next : "/overview"); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败"); }
    finally { setBusy(false); }
  }
  return <AuthShell eyebrow="SIGN IN" title="登录控制台" description="使用本地账号登录，登录后进入管理控制台。">
    {githubEnabled ? (
      <div className="mb-5 space-y-3">
        <Button variant="outline" className="h-10 w-full" onClick={githubLogin}>
          <GitBranch className="size-4" />使用 GitHub 登录
        </Button>
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">或</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      </div>
    ) : null}
    <form onSubmit={submit} className="space-y-5">
      <div className="space-y-2"><Label htmlFor="username">用户名</Label><div className="relative"><UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><Input id="username" name="username" className="pl-9" autoCapitalize="none" autoComplete="username" required autoFocus /></div></div>
      <div className="space-y-2"><Label htmlFor="password">密码</Label><div className="relative"><KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/><Input id="password" name="password" className="pl-9" type="password" autoComplete="current-password" required /></div></div>
      {error ? <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <Button type="submit" className="h-10 w-full" disabled={busy}>{busy ? "正在登录" : "登录"}</Button>
    </form>
  </AuthShell>;
}
