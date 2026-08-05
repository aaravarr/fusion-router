"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  CalendarClock,
  CircleGauge,
  KeyRound,
  ListTree,
  MessageSquareText,
  Menu,
  Network,
  Boxes,
  Settings,
  LogOut,
  UserCog,
  UsersRound,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSession } from "./admin-context";

const navItems = [
  { href: "/chat", label: "聊天", description: "模型对话与调度", icon: MessageSquareText },
  { href: "/overview", label: "总览", description: "账号池健康与恢复", icon: CircleGauge },
  { href: "/usage", label: "用量看板", description: "Token 与请求趋势", icon: BarChart3 },
  { href: "/accounts", label: "账号池", description: "订阅、额度与令牌", icon: UsersRound },
  { href: "/providers", label: "Provider", description: "自定义上游与 API Key", icon: Boxes },
  { href: "/routing", label: "智能路由", description: "优先账号与候选顺序", icon: Network },
  { href: "/api-keys", label: "API 密钥", description: "对外访问凭据", icon: KeyRound },
  { href: "/mcp-tools", label: "MCP 工具", description: "识图等外部工具", icon: Wrench, adminOnly: true },
  { href: "/requests", label: "请求", description: "结果与内部切号", icon: ListTree },
  { href: "/events", label: "事件", description: "恢复与认证记录", icon: CalendarClock },
  { href: "/users", label: "用户", description: "租户与访问权限", icon: UserCog, adminOnly: true },
  { href: "/settings", label: "设置", description: "检查周期与安全", icon: Settings, adminOnly: true },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, logout, isAdmin } = useSession();
  const active = navItems.find((item) => pathname.startsWith(item.href)) ?? navItems[0];

  return (
    <div className="min-h-[100dvh] bg-[#fafafa] lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-[100dvh] border-r bg-white lg:flex lg:flex-col">
        <Sidebar pathname={pathname} />
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-white/90 px-4 backdrop-blur-md sm:px-6">
         <Dialog>
           <DialogTrigger asChild>
             <Button variant="ghost" size="icon" className="-ml-1 lg:hidden" aria-label="打开导航">
               <Menu aria-hidden="true" />
             </Button>
           </DialogTrigger>
           <DialogContent className="gap-0 p-0 sm:max-w-[300px]">
             <DialogTitle className="sr-only">控制台导航</DialogTitle>
             <Sidebar pathname={pathname} mobile />
           </DialogContent>
         </Dialog>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium tracking-[-0.02em]">{active.label}</p>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">{active.description}</p>
          </div>

           <div className="flex items-center gap-2">
             <div className="hidden items-center gap-2 rounded-md border bg-[#fafafa] px-2.5 py-1.5 text-xs text-muted-foreground sm:flex">
              <Activity className="size-3.5 text-success" aria-hidden="true" />
              {user.displayName || user.username} · {isAdmin ? "管理员" : "普通用户"}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" onClick={() => void logout()} aria-label="退出登录">
                  <LogOut aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>退出登录</TooltipContent>
            </Tooltip>
          </div>
        </header>

        <main id="main-content" className={pathname.startsWith("/chat")
          ? "h-[calc(100dvh-3.5rem)] min-h-0 w-full overflow-hidden"
          : "mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8"}>
          {children}
        </main>
      </div>
    </div>
  );
}

function Sidebar({ pathname, mobile = false }: { pathname: string; mobile?: boolean }) {
  const { isAdmin } = useSession();
  const visibleItems = navItems.filter((item) => !("adminOnly" in item && item.adminOnly) || isAdmin);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <span className="grid size-7 place-items-center rounded-md bg-[#171717] text-[11px] font-semibold text-white">O</span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-[-0.025em]">Provider Gateway</p>
          <p className="font-mono text-[10px] text-muted-foreground">ACCOUNT ROUTER</p>
        </div>
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto p-3" aria-label="主导航">
        <p className="px-2 pb-2 pt-1 font-mono text-[10px] font-medium tracking-[0.08em] text-muted-foreground">OPERATE</p>
        <div className="space-y-0.5">
          {visibleItems.filter((item) => !["/events", "/users", "/settings"].includes(item.href)).map((item) => <NavItem key={item.href} item={item} pathname={pathname} mobile={mobile} />)}
        </div>
        <p className="px-2 pb-2 pt-6 font-mono text-[10px] font-medium tracking-[0.08em] text-muted-foreground">SYSTEM</p>
        <div className="space-y-0.5">
          {visibleItems.filter((item) => ["/events", "/users", "/settings"].includes(item.href)).map((item) => <NavItem key={item.href} item={item} pathname={pathname} mobile={mobile} />)}
        </div>
      </nav>
    </div>
  );
}

function NavItem({
  item,
  pathname,
  mobile,
}: {
  item: (typeof navItems)[number];
  pathname: string;
  mobile: boolean;
}) {
  const active = pathname.startsWith(item.href);
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      className={`group flex min-h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors ${
        active ? "bg-[#171717] text-white" : "text-[#4d4d4d] hover:bg-[#f5f5f5] hover:text-[#171717]"
      }`}
      aria-current={active ? "page" : undefined}
    >
      <Icon className={`size-4 ${active ? "text-white" : "text-[#888] group-hover:text-[#171717]"}`} strokeWidth={1.75} aria-hidden="true" />
      <span>{item.label}</span>
    </Link>
  );

  if (!mobile) return link;
  return link;
}
