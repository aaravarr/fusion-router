"use client";

import { useState, type FormEvent } from "react";
import {
  Info,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSession, type SessionUser } from "./admin-context";
import {
  EmptyState,
  ErrorState,
  LoadingTable,
  PageIntro,
  Panel,
  StatsStrip,
  formatDate,
} from "./page-kit";
import { StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";

const SHARING_POOL_OPTIONS = [
  { value: "opencode-go", label: "OpenCode Go", desc: "OpenCode Go 池 · 管理员名下 4 个账号 · Google 登录 + Go API Key" },
  { value: "openai", label: "OpenAI", desc: "OpenAI 池 · 管理员名下 2 个账号 · Codex AT token / OAuth 刷新" },
  { value: "xai-grok", label: "xAI Grok", desc: "xAI Grok 池 · 管理员名下 5 个账号 · 免费 OAuth，滚动 24h" },
  { value: "kimi-code", label: "Kimi Code", desc: "Kimi Code 池 · 管理员名下 3 个账号 · 设备码 OAuth，5h + weekly 额度" },
  { value: "open-design-go", label: "OpenDesign Go", desc: "OpenDesign Go 池 · 管理员名下 1 个账号 · OpenAI 兼容订阅，按月计费" },
  { value: "glm-coding", label: "GLM Coding Plan", desc: "GLM Coding Plan 池 · coding-plan API key（OAuth 自动兑换/手建），5h + weekly 额度" },
  { value: "custom:*", label: "全部自定义 Provider", desc: "自定义 Provider 池 · 管理员名下 6 个账号 · 自定义 API Key 上游" },
];

interface UserSummary extends SessionUser {
  accountCount?: number;
  apiKeyCount?: number;
  lastLoginAt?: string | null;
  sharing?: { enabled: boolean; poolTypes: string[] };
}
interface UsersPayload {
  users?: UserSummary[];
}

export function UsersPage() {
  const { isAdmin, user: current, sessionFetch } = useSession();
  const confirm = useConfirm();
  const resource = useAdminResource<UsersPayload>("/api/admin/users");
  const users = resource.data?.users ?? [];
  const adminCount = users.filter((item) => item.role === "ADMIN").length;
  const activeCount = users.filter((item) => item.status === "ACTIVE").length;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordUser, setPasswordUser] = useState<UserSummary | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [sharingUser, setSharingUser] = useState<UserSummary | null>(null);
  // 设计规格：共享池总开关默认关闭
  const [sharingEnabled, setSharingEnabled] = useState(false);
  const [sharingPoolTypes, setSharingPoolTypes] = useState<Set<string>>(new Set());
  const [sharingBusy, setSharingBusy] = useState(false);
  if (!isAdmin)
    return (
      <Panel>
        <ErrorState message="只有管理员可以管理用户。" />
      </Panel>
    );

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await sessionFetch("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          displayName: form.get("displayName"),
          password: form.get("password"),
          role: form.get("role"),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(payload?.error?.message || "用户创建失败");
      setOpen(false);
      await resource.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "用户创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function update(user: UserSummary, input: Record<string, unknown>) {
    const response = await sessionFetch(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    if (response.ok) await resource.refresh();
    else
      setError(
        (await response.json().catch(() => null))?.error?.message || "操作失败",
      );
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passwordUser || newPassword.length < 6) return;
    setPasswordBusy(true);
    await update(passwordUser, { password: newPassword });
    setPasswordBusy(false);
    setPasswordUser(null);
    setNewPassword("");
  }

  function openSharing(user: UserSummary) {
    setSharingUser(user);
    setSharingEnabled(user.sharing?.enabled ?? false);
    setSharingPoolTypes(new Set(user.sharing?.poolTypes ?? []));
  }

  // 对话框在关闭态（总开关关）时，保存按钮置灰；开关受控于 sharingEnabled。
  // 打开对话框时的默认值即当前用户配置，总开关取 enabled ?? false（默认关）。

  async function saveSharing() {
    if (!sharingUser) return;
    setSharingBusy(true);
    const response = await sessionFetch(`/api/admin/users/${sharingUser.id}/sharing`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: sharingEnabled, poolTypes: [...sharingPoolTypes] }),
    });
    setSharingBusy(false);
    if (response.ok) {
      setSharingUser(null);
      await resource.refresh();
    } else {
      setError((await response.json().catch(() => null))?.error?.message || "保存共享配置失败");
    }
  }

  async function revoke(user: UserSummary) {
    const approved = await confirm({ title: `注销 ${user.username} 的全部会话？`, description: "该用户需要在所有设备上重新登录，当前密码不会改变。", confirmText: "注销全部会话" });
    if (!approved) return;
    const response = await sessionFetch(
      `/api/admin/users/${user.id}/sessions`,
      { method: "DELETE" },
    );
    if (!response.ok)
      setError(
        (await response.json().catch(() => null))?.error?.message ||
          "注销会话失败",
      );
  }

  return (
    <>
      <PageIntro
        eyebrow="TENANT ACCESS"
        title="用户管理"
        description="每位用户拥有独立的账号池、API 密钥和路由状态。管理员查看全局状态时也不会跨用户路由。"
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void resource.refresh()}
            >
              <RefreshCw data-icon="inline-start" />
              刷新
            </Button>
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus data-icon="inline-start" />
              新增用户
            </Button>
          </>
        }
      />
      <div className="mb-4">
        <StatsStrip
          items={[
            { label: "用户总数", value: users.length },
            { label: "启用中", value: activeCount, tone: "success" },
            { label: "管理员", value: adminCount },
            { label: "停用", value: Math.max(0, users.length - activeCount), tone: users.length - activeCount > 0 ? "warning" : "default" },
          ]}
        />
      </div>
      {error ? (
        <p className="mb-4 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Panel
        title="系统用户"
        description={`${users.length} 位用户。停用用户会立即失去控制台和网关访问权限。`}
      >
        {resource.loading ? (
          <LoadingTable rows={5} columns={6} />
        ) : resource.error ? (
          <ErrorState
            message={resource.error}
            onRetry={() => void resource.refresh()}
          />
        ) : !users.length ? (
          <EmptyState
            title="暂无用户"
            description="初始化管理员后会显示在这里。"
          />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
            <TableHeader className="bg-[#fafafa]">
              <TableRow>
                <TableHead className="px-4" style={{ minWidth: 230 }}>用户名</TableHead>
                <TableHead>显示名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>共享池</TableHead>
                <TableHead>注册时间</TableHead>
                <TableHead className="w-40" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => {
                const initial = (user.displayName || user.username || "?").slice(0, 1).toUpperCase();
                return (
                <TableRow key={user.id}>
                  <TableCell className="px-4">
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-[26px] shrink-0 place-items-center rounded-md border bg-[#e9e9e6] text-[11.5px] font-bold text-[#3f3f3f]">
                        {initial}
                      </span>
                      <div className="min-w-0">
                        <p className="font-mono text-[12.5px] font-semibold text-[#171717]">
                          {user.username}
                          {user.id === current.id ? "（你）" : ""}
                        </p>
                        <p className="truncate font-sans text-[11px] text-muted-foreground" style={{ maxWidth: 220, minWidth: 160 }}>
                          {user.displayName || user.username}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {user.displayName || "—"}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[11px] font-semibold ${user.role === "ADMIN" ? "border-accent-blue-soft-2 bg-accent-blue-soft text-accent-blue-strong" : "border-border bg-[#f7f7f5] text-muted-foreground"}`}>
                      {user.role === "ADMIN" ? "ADMIN" : "USER"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={user.status} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {user.sharing?.enabled ? (
                      <span className="inline-flex h-5 items-center rounded-full border border-accent-blue-soft-2 bg-accent-blue-soft px-2 text-[11px] font-semibold text-accent-blue-strong">
                        已共享 {user.sharing.poolTypes.length} 类
                      </span>
                    ) : (
                      <span className="inline-flex h-5 items-center rounded-full border border-border bg-transparent px-2 text-[11px] text-muted-foreground">
                        关
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {formatDate(user.createdAt)}
                  </TableCell>
                  <TableCell className="px-4">
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => openSharing(user)}
                        className="inline-flex h-[26px] items-center gap-1.5 rounded px-2 text-xs font-medium text-accent-blue transition-colors hover:bg-accent-blue-soft"
                      >
                        <Settings2 className="size-3.5" />
                        配置共享池
                      </button>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="用户操作"
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() =>
                            void update(user, {
                              role: user.role === "ADMIN" ? "USER" : "ADMIN",
                            })
                          }
                          disabled={user.id === current.id}
                        >
                          {user.role === "ADMIN"
                            ? "改为普通用户"
                            : "设为管理员"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => { setPasswordUser(user); setNewPassword(""); }}
                        >
                          重置密码
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => openSharing(user)}>
                          配置共享池
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void revoke(user)}>
                          注销全部会话
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className={
                            user.status === "ACTIVE"
                              ? "text-destructive"
                              : undefined
                          }
                          disabled={user.id === current.id}
                          onSelect={() =>
                            void update(user, {
                              status:
                                user.status === "ACTIVE"
                                  ? "DISABLED"
                                  : "ACTIVE",
                            })
                          }
                        >
                          {user.status === "ACTIVE" ? "停用用户" : "重新启用"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              );
              })}
            </TableBody>
          </Table>
            </div>
        )}
      </Panel>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增用户</DialogTitle>
            <DialogDescription>
              账号池和 API 密钥将自动与该用户隔离。
            </DialogDescription>
          </DialogHeader>
          <form id="create-user" onSubmit={create} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-display-name">显示名称</Label>
              <Input id="new-display-name" name="displayName" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-username">用户名</Label>
              <Input
                id="new-username"
                name="username"
                minLength={3}
                maxLength={64}
                autoCapitalize="none"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">初始密码</Label>
              <Input
                id="new-password"
                name="password"
                type="password"
                minLength={6}
                autoComplete="new-password"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-role">角色</Label>
              <Select name="role" defaultValue="USER">
                <SelectTrigger id="new-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">普通用户</SelectItem>
                  <SelectItem value="ADMIN">管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button form="create-user" type="submit" disabled={busy}>
              {busy ? "正在创建" : "创建用户"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(passwordUser)} onOpenChange={(next) => { if (!next && !passwordBusy) { setPasswordUser(null); setNewPassword(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重置用户密码</DialogTitle>
            <DialogDescription>为 {passwordUser?.username} 设置至少 6 个字符的新密码。</DialogDescription>
          </DialogHeader>
          <form id="reset-user-password" onSubmit={submitPassword} className="space-y-2">
            <Label htmlFor="reset-password">新密码</Label>
            <Input id="reset-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={6} autoComplete="new-password" autoFocus required />
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordUser(null)} disabled={passwordBusy}>取消</Button>
            <Button type="submit" form="reset-user-password" disabled={passwordBusy || newPassword.length < 6}>{passwordBusy ? "正在重置" : "重置密码"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(sharingUser)} onOpenChange={(next) => { if (!next && !sharingBusy) setSharingUser(null); }}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>配置共享池</DialogTitle>
            <DialogDescription>用户 <span className="font-mono text-foreground">{sharingUser?.username}</span> · 将管理员名下的账号池共享给该用户路由使用。总开关默认关闭，需逐用户开启并勾选池类型。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3 rounded-md border bg-[#fafafa] p-3.5">
              <div className="min-w-0">
                <p className="text-sm font-medium">启用共享池</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">开启后，该用户的请求可在自有账号之外，路由到下方勾选的管理员账号池。</p>
              </div>
              <Switch checked={sharingEnabled} onCheckedChange={setSharingEnabled} />
            </div>
            <div className="text-xs font-semibold tracking-[0.02em] text-muted-foreground">可共享的池类型</div>
            {sharingEnabled ? (
              <div className="space-y-2">
                {SHARING_POOL_OPTIONS.map((option) => {
                  const checked = sharingPoolTypes.has(option.value);
                  return (
                    <label
                      key={option.value}
                      className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5 transition-colors ${checked ? "border-accent-blue bg-accent-blue-soft" : "border-border bg-white hover:border-[#d6d6d4] hover:bg-[#fbfbfa]"}`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => setSharingPoolTypes((current) => {
                          const next = new Set(current);
                          if (v === true) next.add(option.value); else next.delete(option.value);
                          return next;
                        })}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-[13px] font-medium leading-[18px]">{option.label}</span>
                          <span className="inline-flex items-center rounded-[3px] border bg-[#f7f7f5] px-1.5 font-mono text-[11px] leading-4 text-muted-foreground">{option.value}</span>
                        </span>
                        <span className="mt-1 block text-[11.5px] leading-4 text-muted-foreground">{option.desc}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="flex h-9 items-center rounded-md border bg-[#fafafa] px-3 font-mono text-[11.5px] text-muted-foreground">
                已配置 {sharingPoolTypes.size}/6 个共享池 · 开启后可编辑
              </div>
            )}
            <div className="flex gap-2 rounded-md border border-accent-blue-soft-2 bg-accent-blue-soft p-3 text-xs leading-5">
              <Info className="mt-0.5 size-[15px] shrink-0 text-accent-blue" />
              <span>{sharingEnabled ? <><span className="font-semibold">共享后</span>，该用户的请求可路由到你勾选的账号池；账号凭据与额度管理仍归管理员。</> : "总开关关闭时，该用户请求仅路由其自有账号，勾选明细不生效。"}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSharingUser(null)} disabled={sharingBusy}>取消</Button>
            <Button
              onClick={() => void saveSharing()}
              disabled={
                sharingBusy ||
                !sharingEnabled ||
                sharingPoolTypes.size === 0 ||
                // 设计规格：无变更（开关与勾选均与打开前一致）时保存置灰
                (sharingUser?.sharing?.enabled === sharingEnabled &&
                  (sharingUser?.sharing?.poolTypes ?? []).length === sharingPoolTypes.size &&
                  (sharingUser?.sharing?.poolTypes ?? []).every((item) => sharingPoolTypes.has(item)))
              }
            >
              {sharingBusy ? "正在保存" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
