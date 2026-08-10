"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2, Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "./admin-context";
import { PROVIDER_DOMAIN_PRESETS } from "./domain-presets";
import { ErrorState, PageIntro, Panel } from "./page-kit";
import { getPoolLabel } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import type { LogsCleanupResponse, LogStats } from "./types";
import { copyToClipboard } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Settings {
  domainMirrorMap: DomainMirrorMap;
  domainMirrorGroups: MirrorGroup[];
  upstreamBaseUrl: string;
  opencodeGoMirrorFilter: OpenCodeGoMirrorFilter;
  upstreamRequestTimeoutMs: number;
  maxFailoverAttempts: number;
  maintenanceEnabled: boolean;
  maintenanceIntervalMs: number;
  refreshBatchLimit: number;
  refreshConcurrency: number;
  mediaTtlHours: number;
  mediaMaxBytes: number;
  loggingEnabled: boolean;
  logBodies: boolean;
  logBodiesOnError: boolean;
  logRetentionDays: number;
  maxBodyCaptureBytes: number;
}
interface MirrorTarget { id: string; name: string; url: string; enabled: boolean }
interface MirrorRule { id: string; pattern: string; mirrorId: string; enabled: boolean }
interface DomainMirrorConfig { mirrors: MirrorTarget[]; accountAssignments: Record<string, string>; rules: MirrorRule[] }
type DomainMirrorMap = Record<string, DomainMirrorConfig>;
interface MirrorAccount { id: string; name: string; email?: string | null; poolType: string; poolLabel?: string | null; workspaceId?: string | null }
interface MirrorGroup { id: string; name: string; enabled: boolean; domains: string[]; accountIds: string[]; mirrors: MirrorTarget[]; rules: MirrorRule[] }
interface OpenCodeGoMirrorRule { path: string; operator: "contains" | "equals" | "startsWith" | "regex"; values: string[] }
interface OpenCodeGoMirrorFilter { enabled: boolean; mirrorBaseUrl: string; rules: OpenCodeGoMirrorRule[] }
interface SettingsPayload {
  settings?: Settings;
  secrets?: {
    masterKeyReady?: boolean;
    apiKeyPepperReady?: boolean;
    cronSecretReady?: boolean;
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function SettingsPage() {
  const { isAdmin, sessionFetch } = useSession();
  const confirm = useConfirm();
  const resource = useAdminResource<SettingsPayload>("/api/admin/settings");
  const accountsResource = useAdminResource<{ accounts?: MirrorAccount[] }>("/api/admin/mirror-accounts");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [oneTimeCronSecret, setOneTimeCronSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [stripDialogOpen, setStripDialogOpen] = useState(false);
  const [logStats, setLogStats] = useState<LogStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const form = draft ?? resource.data?.settings ?? null;
  if (!isAdmin)
    return (
      <Panel>
        <ErrorState message="系统配置仅对管理员开放。" />
      </Panel>
    );

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setMessage(null);
    try {
      const response = await sessionFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "保存失败");
      setDraft(payload.settings);
      setMessage("系统配置已保存，即时生效");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }
  async function rotate(name: "cron_secret" | "api_key_pepper") {
    const approved = await confirm({
      title: name === "api_key_pepper" ? "轮换 API Key Pepper？" : "轮换定时任务密钥？",
      description: name === "api_key_pepper" ? "现有 API 密钥会全部失效，客户端必须重新配置。" : "外部定时任务需要改用新密钥。",
      confirmText: "确认轮换",
      destructive: name === "api_key_pepper",
    });
    if (!approved) return;
    const response = await sessionFetch("/api/admin/settings/secrets", {
      method: "POST",
      body: JSON.stringify(name === "api_key_pepper" ? { name, confirmInvalidateAllKeys: true } : { name }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) { setMessage(payload?.error?.message || "轮换失败"); return; }
    if (name === "cron_secret") {
      setOneTimeCronSecret(payload?.secret ?? null);
      setCopied(false);
      setMessage("定时任务密钥已轮换，请立即保存新密钥");
    } else {
      setMessage(`API Key Pepper 已轮换，${payload?.invalidatedApiKeys ?? 0} 个现有 API Key 已停用`);
    }
  }
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({
      ...(current ?? resource.data!.settings!),
      [key]: value,
    }));
  async function loadLogStats() {
    setStatsLoading(true);
    try {
      const response = await sessionFetch("/api/admin/logs/stats");
      if (response.ok) setLogStats(await response.json().catch(() => null));
    } catch {
      setLogStats(null);
    } finally {
      setStatsLoading(false);
    }
  }
  useEffect(() => {
    void loadLogStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function cleanupLogs(options: { retentionDays?: number; stripBodies?: boolean }) {
    setCleanupBusy(true);
    setMessage(null);
    try {
      const response = await sessionFetch("/api/admin/logs/cleanup", {
        method: "POST",
        body: JSON.stringify(options),
      });
      const payload = await response.json().catch(() => null) as LogsCleanupResponse | { error?: { message?: string } } | null;
      if (!response.ok) throw new Error((payload as { error?: { message?: string } })?.error?.message || "清理失败");
      const result = payload as LogsCleanupResponse;
      const parts: string[] = [];
      if (result.deletedRequests != null) parts.push(`删除 ${result.deletedRequests} 条请求`);
      if (result.deletedBodies != null) parts.push(`删除 ${result.deletedBodies} 条 body`);
      if (result.stripped != null) parts.push(`剥离 ${result.stripped} 条 body`);
      setMessage(parts.length ? parts.join("，") : "没有需要清理的数据");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "清理失败");
    } finally {
      setCleanupBusy(false);
      void loadLogStats();
    }
  }
  return (
    <>
      <PageIntro
        eyebrow="SYSTEM SETTINGS"
        title="系统设置"
        description="Provider 网络、额度维护与日志策略统一保存在数据库中，无需编辑 .env。修改后即时生效。"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void resource.refresh()}
          >
            <RefreshCw data-icon="inline-start" />
            重新载入
          </Button>
        }
      />
      {resource.error ? (
        <Panel>
          <ErrorState
            message={resource.error}
            onRetry={() => void resource.refresh()}
          />
        </Panel>
      ) : null}
      {form ? (
        <form onSubmit={save} className="space-y-4">
          <Panel
            title="Provider 网络"
            description="集中管理各 Provider 的域名镜像，以及 OpenCode Go 的专用上游地址。"
          >
            <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-2">
              <div className="lg:col-span-2">
              <Field label="域名镜像路由" description="按账号组管理多个原始域名和多个镜像节点；规则优先，未命中时按账号 ID Hash 分片。">
                <DomainMirrorsEditor value={form.domainMirrorGroups ?? []} legacyValue={form.domainMirrorMap} accounts={accountsResource.data?.accounts ?? []} onChange={(value) => setDraft({ ...form, domainMirrorGroups: value, domainMirrorMap: {} })} />
              </Field>
              </div>
              <Field label="请求上游地址" description="Go API Key 调用的官方上游地址，仅支持 opencode.ai 官方 HTTPS 端点。">
                <Input
                  type="url"
                  value={form.upstreamBaseUrl}
                  onChange={(e) => update("upstreamBaseUrl", e.target.value)}
                  required
                />
              </Field>
              <div className="lg:col-span-2">
                <Field
                  label="OpenCode Go 按模型镜像"
                  description="opencode.ai 官方对部分模型存在地区限制（如中国大陆出口 403），可为这些模型单独配置镜像地址；未命中规则的模型仍走官方直连。"
                >
                  <OpenCodeGoMirrorEditor
                    value={form.opencodeGoMirrorFilter ?? { enabled: false, mirrorBaseUrl: "", rules: [] }}
                    onChange={(next) => {
                      if (form.opencodeGoMirrorFilter) update("opencodeGoMirrorFilter", next);
                    }}
                  />
                </Field>
              </div>
              <Field label="上游请求超时（毫秒）" description="单次上游请求的超时上限，超时后中断连接。范围 1000-600000 毫秒。">
                <Input
                  type="number"
                  min={1000}
                  max={600000}
                  value={form.upstreamRequestTimeoutMs}
                  onChange={(e) =>
                    update("upstreamRequestTimeoutMs", Number(e.target.value))
                  }
                  required
                />
              </Field>
              <Field label="单请求最大切号次数" description="达到上限后停止继续扫描账号池，并在同一条请求记录中返回明确错误。范围 1-32。">
                <Input
                  type="number"
                  min={1}
                  max={32}
                  value={form.maxFailoverAttempts}
                  onChange={(e) => update("maxFailoverAttempts", Number(e.target.value))}
                  required
                />
              </Field>
            </div>
          </Panel>
          <Panel
            title="维护任务"
            description="按各 Provider 的同步方式刷新近期使用账号；长期闲置账号不会被反复探测。"
          >
            <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-3">
              <Field label="执行间隔（毫秒）">
                <Input
                  type="number"
                  min={10000}
                  value={form.maintenanceIntervalMs}
                  onChange={(e) =>
                    update("maintenanceIntervalMs", Number(e.target.value))
                  }
                />
              </Field>
              <Field label="每批检查账号数">
                <Input
                  type="number"
                  min={1}
                  max={500}
                  value={form.refreshBatchLimit}
                  onChange={(e) =>
                    update("refreshBatchLimit", Number(e.target.value))
                  }
                />
              </Field>
              <Field label="检查并发数">
                <Input
                  type="number"
                  min={1}
                  max={32}
                  value={form.refreshConcurrency}
                  onChange={(e) =>
                    update("refreshConcurrency", Number(e.target.value))
                  }
                />
              </Field>
              <Toggle
                checked={form.maintenanceEnabled}
                onChange={(value) => update("maintenanceEnabled", value)}
                label="启用额度维护调度"
                description="常驻 Node/Docker 部署建议开启；失效的 Console 会话会标记为需要重新登录。"
              />
            </div>
          </Panel>
          <Panel
            title="临时媒体存储"
            description="模型不支持图片输入时，将 data URI 图片临时落盘并生成带签名 URL 引用（供 MCP 识图等外层取图）。图片按内容去重，过期后自动清理。"
          >
            <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-2">
              <Field label="保留时长（小时）">
                <Input
                  type="number"
                  min={1}
                  max={720}
                  value={form.mediaTtlHours}
                  onChange={(e) =>
                    update("mediaTtlHours", Number(e.target.value))
                  }
                />
              </Field>
              <Field label="容量上限（MB）">
                <Input
                  type="number"
                  min={1}
                  max={10240}
                  value={Math.round(form.mediaMaxBytes / (1024 * 1024))}
                  onChange={(e) =>
                    update("mediaMaxBytes", Math.round(Number(e.target.value)) * 1024 * 1024)
                  }
                />
              </Field>
            </div>
          </Panel>
          <Panel
            title="自动生成的安全密钥"
            description="首次启动自动生成并安全保存。通常无需查看或手动配置。"
          >
            <div className="divide-y">
              <SecretRow
                label="主加密密钥"
                ready={resource.data?.secrets?.masterKeyReady}
              />
              <SecretRow
                label="API Key Pepper"
                ready={resource.data?.secrets?.apiKeyPepperReady}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void rotate("api_key_pepper")}
                  >
                    <RotateCcw />
                    轮换
                  </Button>
                }
              />
              <SecretRow
                label="定时任务密钥"
                ready={resource.data?.secrets?.cronSecretReady}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void rotate("cron_secret")}
                  >
                    <RotateCcw />
                    轮换
                  </Button>
                }
              />
            </div>
          </Panel>
          <Panel
            title="请求日志"
            description="默认只记元数据，调试时才开 body。"
          >
            <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-2">
              <Toggle
                checked={form.loggingEnabled}
                onChange={(value) => update("loggingEnabled", value)}
                label="启用日志"
                description="关闭后不再记录新请求的元数据和 body。"
              />
              <Toggle
                checked={form.logBodies}
                onChange={(value) => update("logBodies", value)}
                label="记录请求/响应体"
                description="数据量大，仅调试开启。"
                danger
              />
              <Toggle
                checked={form.logBodiesOnError}
                onChange={(value) => update("logBodiesOnError", value)}
                label="失败时记录响应体"
                description="默认开启，便于排查错误。"
              />
              <Field label="保留天数">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={form.logRetentionDays}
                  onChange={(e) => update("logRetentionDays", Number(e.target.value))}
                  required
                />
              </Field>
              <Field label="body 截断字节">
                <Input
                  type="number"
                  min={1024}
                  value={form.maxBodyCaptureBytes}
                  onChange={(e) => update("maxBodyCaptureBytes", Number(e.target.value))}
                  required
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t bg-[#fafafa] px-4 py-3 sm:px-5">
              <span className="mr-auto text-[11px] leading-5 text-muted-foreground">
                {statsLoading ? (
                  "日志占用统计中…"
                ) : logStats ? (
                  <>
                    当前日志占用：数据库 {formatBytes(logStats.dbFileBytes)} · 请求体{" "}
                    {formatBytes(logStats.bodies.bytes)}（{logStats.bodies.count} 条）· 请求{" "}
                    {logStats.requests} 条 · 保留 {logStats.retentionDays} 天
                    {logStats.logBodies ? (
                      <span className="ml-1 text-warning">（正在记录请求/响应体）</span>
                    ) : null}
                  </>
                ) : (
                  "日志占用统计不可用"
                )}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={cleanupBusy}
                onClick={() => void cleanupLogs({ retentionDays: form.logRetentionDays })}
              >
                <Trash2 data-icon="inline-start" />
                {cleanupBusy ? "正在清理" : "立即清理过期日志"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={cleanupBusy}
                onClick={() => setStripDialogOpen(true)}
              >
                <Trash2 data-icon="inline-start" />
                剥离历史 body
              </Button>
            </div>
          </Panel>
          <div className="sticky bottom-4 flex items-center justify-between rounded-lg border bg-white/95 p-3 shadow-lg backdrop-blur">
            <p className="text-xs text-muted-foreground" role="status">
              {message || "配置保存在持久数据目录和数据库中。"}
            </p>
            <Button type="submit" disabled={saving}>
              <Save data-icon="inline-start" />
              {saving ? "正在保存" : "保存设置"}
            </Button>
          </div>
        </form>
      ) : null}
      <Dialog open={Boolean(oneTimeCronSecret)} onOpenChange={(open) => { if (!open) { setOneTimeCronSecret(null); setCopied(false); } }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>立即保存新的 Cron Secret</DialogTitle>
            <DialogDescription>该密钥只显示一次。关闭后无法再次查看，只能重新轮换。</DialogDescription>
          </DialogHeader>
          <div className="select-all break-all rounded-md border bg-[#fafafa] p-3 font-mono text-xs leading-5">{oneTimeCronSecret}</div>
          <Button variant="outline" className="w-full" onClick={async () => { if (!oneTimeCronSecret) return; if (await copyToClipboard(oneTimeCronSecret)) setCopied(true); }}>
            {copied ? <Check /> : <Copy />}{copied ? "已复制" : "复制密钥"}
          </Button>
          <DialogFooter><Button onClick={() => { setOneTimeCronSecret(null); setCopied(false); }}>我已安全保存</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={stripDialogOpen} onOpenChange={setStripDialogOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>剥离历史 body</DialogTitle>
            <DialogDescription>
              该操作会清除所有历史请求记录的请求体和响应体，保留元数据。不可恢复，确认继续？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStripDialogOpen(false)}>取消</Button>
            <Button
              onClick={async () => {
                setStripDialogOpen(false);
                await cleanupLogs({ stripBodies: true });
              }}
            >
              确认剥离
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {description ? <p className="text-xs leading-4 text-muted-foreground">{description}</p> : null}
      {children}
    </div>
  );
}

function newId(prefix: string) {
  return `${prefix}_${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
}

function DomainMirrorsEditor({ value, legacyValue, accounts, onChange }: { value: MirrorGroup[]; legacyValue: DomainMirrorMap; accounts: MirrorAccount[]; onChange: (value: MirrorGroup[]) => void }) {
  const confirm = useConfirm();
  const groups = value.length ? value : migrateLegacyMirrorGroups(legacyValue);
  const [editingGroup, setEditingGroup] = useState<MirrorGroup | null | undefined>(undefined);
  async function removeGroup(id: string) {
    const group = groups.find((item) => item.id === id);
    const approved = await confirm({ title: `删除镜像组${group?.name ? `“${group.name}”` : ""}？`, description: "组内的域名、规则和账号绑定会一起移除。保存设置后生效。", confirmText: "删除镜像组", destructive: true });
    if (!approved) return;
    onChange(groups.filter((group) => group.id !== id));
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-start gap-3">
      <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">每组包含一批账号、多个原始域名和多个镜像地址。组内先按正则规则选择节点，未命中时按账号 ID 稳定 Hash；地址中的 <code className="text-foreground">$host</code> 会替换为原始请求 host。</p>
      <Button type="button" size="sm" onClick={() => setEditingGroup(null)}><Plus />新增镜像组</Button>
    </div>
    {groups.length ? <div className="space-y-2">
      {groups.map((group) => <div key={group.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-white px-3 py-3">
        <div className="min-w-48 flex-1">
          <div className="flex items-center gap-2"><p className="text-sm font-medium">{group.name}</p><span className={`rounded-full px-2 py-0.5 text-[10px] ${group.enabled ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>{group.enabled ? "启用" : "停用"}</span></div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{group.mirrors.map((mirror) => mirror.name).join(" · ")}</p>
        </div>
        <div className="text-right text-[11px] leading-5 text-muted-foreground"><p>{group.accountIds.length ? `${group.accountIds.length} 个账号` : "全部账号"} · {group.mirrors.length} 个镜像 · {group.rules.length} 条规则</p><p className="max-w-80 truncate font-mono">{group.domains.length} 个域名 · {group.domains.join(", ")}</p></div>
        <div className="flex gap-1"><Button type="button" variant="outline" size="sm" onClick={() => setEditingGroup(group)}>编辑</Button><Button type="button" variant="ghost" size="icon-sm" className="text-destructive" onClick={() => removeGroup(group.id)}><Trash2 /></Button></div>
      </div>)}
    </div> : <div className="rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">暂无镜像组</div>}
    {editingGroup !== undefined ? <MirrorGroupDialog key={editingGroup?.id ?? "new"} group={editingGroup} groups={groups} accounts={accounts} onClose={() => setEditingGroup(undefined)} onSave={(group) => { onChange(editingGroup ? groups.map((item) => item.id === editingGroup.id ? group : item) : [...groups, group]); setEditingGroup(undefined); }} /> : null}
  </div>;
}

function migrateLegacyMirrorGroups(value: DomainMirrorMap): MirrorGroup[] {
  return Object.entries(value).map(([domain, config]) => ({
    id: `legacy_group_${domain.replace(/[^a-z0-9]+/g, "_")}`, name: domain, enabled: true, domains: [domain],
    accountIds: Object.keys(config.accountAssignments), mirrors: config.mirrors,
    rules: [
      ...Object.entries(config.accountAssignments).map(([accountId, mirrorId], index) => ({ id: `legacy_assignment_${index}`, pattern: `^${accountId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, mirrorId, enabled: true })),
      ...config.rules,
    ],
  }));
}

function MirrorGroupDialog({ group, groups, accounts, onClose, onSave }: { group: MirrorGroup | null; groups: MirrorGroup[]; accounts: MirrorAccount[]; onClose: () => void; onSave: (group: MirrorGroup) => void }) {
  const presetDomains = PROVIDER_DOMAIN_PRESETS.flatMap((item) => item.domains);
  const [name, setName] = useState(group?.name ?? "");
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [domains, setDomains] = useState<Set<string>>(new Set(group?.domains ?? []));
  const [customDomains, setCustomDomains] = useState<string[]>(group?.domains.filter((domain) => !presetDomains.some((item) => item.domain === domain)) ?? []);
  const [customDomain, setCustomDomain] = useState("");
  const [mirrors, setMirrors] = useState<MirrorTarget[]>(group?.mirrors ?? []);
  const [mirrorName, setMirrorName] = useState("");
  const [mirrorUrl, setMirrorUrl] = useState("");
  const [rules, setRules] = useState<MirrorRule[]>(group?.rules ?? []);
  const [pattern, setPattern] = useState("");
  const [ruleMirrorId, setRuleMirrorId] = useState("");
  const [accountIds, setAccountIds] = useState<Set<string>>(new Set(group?.accountIds ?? []));
  const [query, setQuery] = useState("");
  const knownDomains = [...new Set([...presetDomains.map((item) => item.domain), ...groups.flatMap((item) => item.domains), ...customDomains])];
  const filteredAccounts = useMemo(() => { const q = query.trim().toLowerCase(); return accounts.filter((account) => !q || [account.name, account.email, account.id, account.workspaceId, account.poolType, account.poolLabel].some((item) => String(item || "").toLowerCase().includes(q))).slice(0, 100); }, [accounts, query]);
  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) { setter((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function addCustomDomain() {
    const domain = customDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!domain) return;
    setCustomDomains((current) => current.includes(domain) ? current : [...current, domain]);
    setDomains((current) => new Set([...current, domain])); setCustomDomain("");
  }
  function removeMirror(id: string) { setMirrors((current) => current.filter((mirror) => mirror.id !== id)); setRules((current) => current.filter((rule) => rule.mirrorId !== id)); if (ruleMirrorId === id) setRuleMirrorId(""); }
  const valid = Boolean(name.trim() && domains.size && mirrors.length);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
    <DialogHeader><DialogTitle>{group ? "编辑镜像组" : "新增镜像组"}</DialogTitle><DialogDescription>先选定这组账号，再为该组配置多个镜像节点和节点选择规则。</DialogDescription></DialogHeader>
    <div className="space-y-5 py-1">
      <Field label="组名称"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 XAI 账号组" /></Field>
      <label className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={enabled} onCheckedChange={(value) => setEnabled(value === true)} />启用这个镜像组</label>
      <Field label={`账号（已选 ${accountIds.size} 个）`} description="只有选中的账号会进入本组；不选账号表示该组对匹配域名下的全部账号生效。"><Input className="mb-2 h-8 text-xs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号" /><div className="max-h-44 overflow-y-auto rounded-md border">{filteredAccounts.map((account) => <label key={account.id} className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-xs transition-colors hover:bg-muted/40 last:border-b-0"><Checkbox checked={accountIds.has(account.id)} onCheckedChange={() => toggle(setAccountIds, account.id)} /><span className="min-w-0 flex-1 truncate">{account.name || account.email || account.id}</span><span className="text-[11px] text-muted-foreground">{getPoolLabel(account.poolType, account.poolLabel)}</span></label>)}</div></Field>
      <Field label={`原始域名（已选 ${domains.size} 个）`} description="一组可以包含多个需要代理的原始域名。"><div className="grid max-h-44 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">{knownDomains.map((domain) => { const preset = presetDomains.find((item) => item.domain === domain); return <label key={domain} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-muted/40"><Checkbox checked={domains.has(domain)} onCheckedChange={() => toggle(setDomains, domain)} /><span className="min-w-0 truncate font-mono">{domain}</span>{preset ? <span className="ml-auto truncate text-[10px] text-muted-foreground">{preset.label}</span> : null}</label>; })}</div><div className="mt-2 flex gap-2"><Input className="h-8 flex-1 font-mono text-xs" value={customDomain} onChange={(event) => setCustomDomain(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomDomain(); } }} placeholder="其他域名，例如 custom.example.com" /><Button type="button" variant="outline" size="sm" onClick={addCustomDomain} disabled={!customDomain.trim()}>添加</Button></div></Field>
      <Field label={`镜像节点（${mirrors.length} 个）`} description="每组可以添加多个地址；$host 会替换成请求的原始 host。"><div className="space-y-2">{mirrors.map((mirror) => <div key={mirror.id} className="grid items-center gap-2 sm:grid-cols-[28px_140px_1fr_34px]"><Checkbox checked={mirror.enabled} onCheckedChange={(value) => setMirrors((current) => current.map((item) => item.id === mirror.id ? { ...item, enabled: value === true } : item))} /><Input className="h-8 text-xs" value={mirror.name} onChange={(event) => setMirrors((current) => current.map((item) => item.id === mirror.id ? { ...item, name: event.target.value } : item))} /><Input className="h-8 font-mono text-xs" value={mirror.url} onChange={(event) => setMirrors((current) => current.map((item) => item.id === mirror.id ? { ...item, url: event.target.value } : item))} /><Button type="button" variant="ghost" size="icon-sm" onClick={() => removeMirror(mirror.id)}><Trash2 /></Button></div>)}<div className="grid gap-2 sm:grid-cols-[140px_1fr_auto]"><Input className="h-8 text-xs" value={mirrorName} onChange={(event) => setMirrorName(event.target.value)} placeholder="节点名称" /><Input className="h-8 font-mono text-xs" value={mirrorUrl} onChange={(event) => setMirrorUrl(event.target.value)} placeholder="https://mirror.ahao1.tech/$host" /><Button type="button" variant="outline" size="sm" disabled={!mirrorName.trim() || !mirrorUrl.trim()} onClick={() => { setMirrors((current) => [...current, { id: newId("mirror"), name: mirrorName.trim(), url: mirrorUrl.trim(), enabled: true }]); setMirrorName(""); setMirrorUrl(""); }}><Plus />节点</Button></div></div></Field>
      <Field label={`路由规则（${rules.length} 条）`} description="按顺序匹配账号名称、邮箱、ID、工作区或账号池；未命中时在启用节点间稳定 Hash。"><div className="space-y-2">{rules.map((rule) => <div key={rule.id} className="grid items-center gap-2 sm:grid-cols-[28px_1fr_150px_34px]"><Checkbox checked={rule.enabled} onCheckedChange={(value) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled: value === true } : item))} /><Input className="h-8 font-mono text-xs" value={rule.pattern} onChange={(event) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, pattern: event.target.value } : item))} /><MirrorSelect mirrors={mirrors} value={rule.mirrorId} onChange={(mirrorId) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, mirrorId } : item))} /><Button type="button" variant="ghost" size="icon-sm" onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}><Trash2 /></Button></div>)}<div className="grid gap-2 sm:grid-cols-[1fr_150px_auto]"><Input className="h-8 font-mono text-xs" value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="例如 @example\\.com$ 或 ^prod-" /><MirrorSelect mirrors={mirrors} value={ruleMirrorId} onChange={setRuleMirrorId} /><Button type="button" variant="outline" size="sm" disabled={!pattern.trim() || !ruleMirrorId} onClick={() => { setRules((current) => [...current, { id: newId("rule"), pattern: pattern.trim(), mirrorId: ruleMirrorId, enabled: true }]); setPattern(""); }}><Plus />规则</Button></div></div></Field>
    </div>
    <DialogFooter><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="button" disabled={!valid} onClick={() => onSave({ id: group?.id ?? newId("group"), name: name.trim(), enabled, domains: [...domains], accountIds: [...accountIds], mirrors, rules })}>保存镜像组</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function MirrorSelect({ mirrors, value, onChange }: { mirrors: MirrorTarget[]; value: string; onChange: (value: string) => void }) {
  return <Select value={value || "none"} onValueChange={(next) => onChange(next === "none" ? "" : next)}><SelectTrigger className="w-full bg-white text-xs"><SelectValue placeholder="选择节点" /></SelectTrigger><SelectContent><SelectItem value="none">选择节点</SelectItem>{mirrors.map((mirror) => <SelectItem key={mirror.id} value={mirror.id}>{mirror.name}</SelectItem>)}</SelectContent></Select>;
}
function Toggle({
  checked,
  onChange,
  label,
  description,
  danger,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description: string;
  danger?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-md border p-3 ${danger && checked ? "border-destructive/25 bg-destructive/5" : "bg-[#fafafa]"}`}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}
function OpenCodeGoMirrorEditor({ value, onChange }: { value: OpenCodeGoMirrorFilter; onChange: (value: OpenCodeGoMirrorFilter) => void }) {
  function updateRule(index: number, rule: OpenCodeGoMirrorRule) {
    onChange({ ...value, rules: value.rules.map((item, i) => (i === index ? rule : item)) });
  }
  function removeRule(index: number) {
    onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) });
  }
  function addRule() {
    onChange({ ...value, rules: [...value.rules, { path: "", operator: "contains", values: [] }] });
  }
  return (
    <div className="space-y-3">
      <Toggle
        checked={value.enabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
        label="启用按模型镜像"
        description="为受地区限制的模型单独配置镜像地址，其余模型保持官方直连。"
      />
      <Field label="镜像基础地址" description="命中规则的上游请求会替换为该镜像地址。">
        <Input
          type="url"
          value={value.mirrorBaseUrl}
          onChange={(event) => onChange({ ...value, mirrorBaseUrl: event.target.value })}
          placeholder="https://mirror.example.com"
        />
      </Field>
      <Field
        label={`匹配规则（${value.rules.length} 条）`}
        description="命中任一规则的请求走镜像地址；规则为空时启用后全部请求走镜像。"
      >
        <div className="space-y-2">
          {value.rules.map((rule, index) => (
            <div key={index} className="grid items-center gap-2 sm:grid-cols-[1fr_150px_1fr_34px]">
              <Input
                className="h-8 font-mono text-xs"
                value={rule.path}
                onChange={(event) => updateRule(index, { ...rule, path: event.target.value })}
                placeholder="例如 model"
              />
              <Select
                value={rule.operator}
                onValueChange={(operator) => updateRule(index, { ...rule, operator: operator as OpenCodeGoMirrorRule["operator"] })}
              >
                <SelectTrigger className="w-full bg-white text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="contains">contains</SelectItem>
                  <SelectItem value="equals">equals</SelectItem>
                  <SelectItem value="startsWith">startsWith</SelectItem>
                  <SelectItem value="regex">regex</SelectItem>
                </SelectContent>
              </Select>
              <Input
                className="h-8 font-mono text-xs"
                value={rule.values.join(", ")}
                onChange={(event) =>
                  updateRule(index, {
                    ...rule,
                    values: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
                  })
                }
                placeholder="grok, gpt"
              />
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeRule(index)}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={addRule}>
            <Plus />添加规则
          </Button>
        </div>
      </Field>
      <p className="text-xs leading-5 text-muted-foreground">
        命中任一规则的请求走镜像地址，其余走官方直连；例如 path=model、operator=contains、values=grok,gpt
        表示模型名含 grok 或 gpt 时走镜像。
      </p>
    </div>
  );
}

function SecretRow({
  label,
  ready,
  action,
}: {
  label: string;
  ready?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 sm:px-5">
      <span
        className={`grid size-8 place-items-center rounded-md border ${ready ? "border-success/20 bg-success-soft" : "bg-[#fafafa]"}`}
      >
        {ready ? (
          <ShieldCheck className="size-4 text-success" />
        ) : (
          <AlertTriangle className="size-4 text-warning" />
        )}
      </span>
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          {ready ? "已安全生成" : "尚未就绪"}
        </p>
      </div>
      {action}
    </div>
  );
}
