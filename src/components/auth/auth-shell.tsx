import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";

export function AuthShell({ title, description, children, eyebrow }: { title: string; description: string; children: ReactNode; eyebrow: string }) {
  return (
    <main className="grid min-h-[100dvh] grid-cols-1 bg-[#fafafa] lg:grid-cols-[minmax(0,1fr)_480px]">
      <section className="hidden border-r bg-white px-12 py-10 lg:flex lg:flex-col lg:justify-between">
        <Brand />
        <div className="max-w-xl pb-8">
          <div className="mb-5 flex size-10 items-center justify-center rounded-lg border bg-[#fafafa]">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </div>
          <h1 className="max-w-lg text-4xl font-semibold tracking-[-0.045em] text-balance">一个入口，管理多个 Provider 账号池。</h1>
          <p className="mt-5 max-w-md text-base leading-7 text-muted-foreground">账号、API 密钥、路由偏好与使用记录严格按用户隔离。管理员可查看系统健康，但不会借用其他用户的账号。</p>
        </div>
        <p className="font-mono text-xs text-muted-foreground">SELF-HOSTED · TENANT ISOLATED</p>
      </section>
      <section className="flex min-h-[100dvh] items-start px-6 pt-16 pb-12 sm:items-center sm:px-12 sm:py-12">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 lg:hidden"><Brand /></div>
          <p className="mb-3 font-mono text-[10px] font-medium tracking-[.12em] text-muted-foreground">{eyebrow}</p>
          <h2 className="text-2xl font-semibold tracking-[-0.035em]">{title}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
          <div className="mt-8">{children}</div>
        </div>
      </section>
    </main>
  );
}

export function Brand() {
  return (
    <div className="flex items-center gap-2.5" aria-label="Fusion Router">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="size-7 shrink-0">
        <path d="M32 8.5 L52.4 20.3 L52.4 43.7 L32 55.5 L11.6 43.7 L11.6 20.3 Z" stroke="#2563EB" strokeWidth="6" strokeLinejoin="round" />
        <path d="M32 32 L32 8.5 M32 32 L52.4 43.7 M32 32 L11.6 43.7" stroke="#2563EB" strokeWidth="6" strokeLinecap="round" />
        <circle cx="32" cy="32" r="7" fill="#2563EB" />
        <circle cx="32" cy="8.5" r="4.5" fill="#2563EB" />
        <circle cx="52.4" cy="43.7" r="4.5" fill="#2563EB" />
        <circle cx="11.6" cy="43.7" r="4.5" fill="#2563EB" />
      </svg>
      <span className="text-sm font-semibold tracking-[-0.025em]">Fusion Router</span>
    </div>
  );
}
