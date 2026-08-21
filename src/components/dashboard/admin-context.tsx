"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "DISABLED";
  createdAt?: string;
}

interface SessionContextValue {
  user: SessionUser;
  sessionFetch: (path: string, init?: RequestInit) => Promise<Response>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  isAdmin: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

function withJsonHeaders(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

export function SessionProvider({ children }: PropsWithChildren) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const refreshSession = useCallback(async () => {
    setLoading(true);
    setVerifyError(null);
    try {
      const response = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "same-origin",
        // 防止服务端被慢查询阻塞时（例如日志统计大表全表扫描）前端无限停留在"正在验证会话"。
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        const payload = await response.json();
        setUser(payload.user);
        return;
      }
      setUser(null);
      const status = await fetch("/api/bootstrap/status", { cache: "no-store", signal: AbortSignal.timeout(10000) })
        .then((result) => result.json()).catch(() => null);
      router.replace(status?.initialized ? `/login?next=${encodeURIComponent(pathname)}` : "/setup");
    } catch (cause) {
      const aborted = cause instanceof DOMException && cause.name === "AbortError";
      if (!aborted) console.error("会话验证失败", cause);
      setUser(null);
      setVerifyError(aborted ? "会话验证超时，请重试" : "会话验证失败，请重试");
    } finally {
      setLoading(false);
    }
  }, [pathname, router]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSession(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshSession]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => null);
    setUser(null);
    router.replace("/login");
    router.refresh();
  }, [router]);

  const sessionFetch = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: withJsonHeaders(init),
      cache: "no-store",
    });
    if (response.status === 401) {
      setUser(null);
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
    return response;
  }, [pathname, router]);

  const value = useMemo<SessionContextValue | null>(() => user ? ({
    user,
    sessionFetch,
    logout,
    refreshSession,
    isAdmin: user.role === "ADMIN",
  }) : null, [logout, refreshSession, sessionFetch, user]);

  if (loading || !value) {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-[#fafafa]">
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
          {verifyError ? (
            <>
              <div>{verifyError}</div>
              <button
                type="button"
                onClick={() => void refreshSession()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                重试
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />正在验证会话
            </div>
          )}
        </div>
      </main>
    );
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession 必须在 SessionProvider 内使用");
  return value;
}

// 暂时保留旧名称，现有页面可渐进迁移；底层已完全使用 HttpOnly 会话。
export const AdminProvider = SessionProvider;
export function useAdmin() {
  const session = useSession();
  return { ...session, adminFetch: session.sessionFetch, lock: session.logout };
}
