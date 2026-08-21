"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import {
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
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

const SHARING_POOL_OPTIONS = [
  { value: "opencode-go", label: "OpenCode Go" },
  { value: "openai", label: "OpenAI" },
  { value: "xai-grok", label: "xAI Grok" },
  { value: "kimi-code", label: "Kimi Code" },
  { value: "open-design-go", label: "OpenDesign Go" },
  { value: "custom:*", label: "自定义 Provider（全部）" },
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
          <Table className="min-w-[900px]">
            <TableHeader className="bg-[#fafafa]">
              <TableRow>
                <TableHead className="px-4">用户</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>Provider 账号</TableHead>
                <TableHead>API 密钥</TableHead>
                <TableHead>共享池</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead className="w-14" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="px-4">
                    <div className="flex items-center gap-3">
                      <span className="grid size-8 place-items-center rounded-md border bg-[#fafafa]">
                        <UserRound className="size-4 text-muted-foreground" />
                      </span>
                      <div>
                        <p className="text-sm font-medium">
                          {user.displayName || user.username}
                          {user.id === current.id ? "（你）" : ""}
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {user.username}
                        </p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.role === "ADMIN" ? (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <ShieldCheck className="size-3.5" />
                        管理员
                      </span>
                    ) : (
                      <span className="text-xs">普通用户</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={user.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/users/${user.id}`} className="underline-offset-4 hover:underline">
                      {user.accountCount ?? 0} · 查看
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {user.apiKeyCount ?? 0}
                  </TableCell>
                  <TableCell className="text-xs">
                    {user.sharing?.enabled
                      ? `已开启 ${user.sharing.poolTypes.length} 类`
                      : "关闭"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {formatDate(user.createdAt)}
                  </TableCell>
                  <TableCell>
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>配置共享管理员账号池</DialogTitle>
            <DialogDescription>允许 {sharingUser?.username} 复用管理员账号池中的账号（自有账号优先）。仅当管理员开启后明细才生效。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="flex cursor-pointer items-center gap-3 rounded-md border bg-[#fafafa] p-3">
              <Checkbox checked={sharingEnabled} onCheckedChange={(v) => setSharingEnabled(v === true)} />
              <span>
                <span className="block text-sm font-medium">启用共享管理员账号池</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">关闭时忽略下方勾选。</span>
              </span>
            </label>
            <div className="space-y-1">
              {SHARING_POOL_OPTIONS.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors hover:bg-muted/40">
                  <Checkbox
                    checked={sharingPoolTypes.has(option.value)}
                    disabled={!sharingEnabled}
                    onCheckedChange={(v) => setSharingPoolTypes((current) => {
                      const next = new Set(current);
                      if (v === true) next.add(option.value); else next.delete(option.value);
                      return next;
                    })}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSharingUser(null)} disabled={sharingBusy}>取消</Button>
            <Button onClick={() => void saveSharing()} disabled={sharingBusy}>{sharingBusy ? "正在保存" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
