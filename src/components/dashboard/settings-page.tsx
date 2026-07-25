"use client";

import { useMemo, useState, type FormEvent } from "react";
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
import { useAdminResource } from "./use-admin-resource";
import type { LogsCleanupResponse } from "./types";

interface Settings {
  domainMirrorMap: DomainMirrorMap;
  upstreamBaseUrl: string;
  upstreamRequestTimeoutMs: number;
  maintenanceEnabled: boolean;
  maintenanceIntervalMs: number;
  refreshBatchLimit: number;
  refreshConcurrency: number;
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
interface MirrorAccount { id: string; name: string; email?: string | null; poolType: string; workspaceId?: string | null }
interface MirrorGroup extends MirrorTarget { domains: string[]; accountIds: string[]; rules: Array<Omit<MirrorRule, "mirrorId">> }
interface SettingsPayload {
  settings?: Settings;
  secrets?: {
    masterKeyReady?: boolean;
    apiKeyPepperReady?: boolean;
    cronSecretReady?: boolean;
  };
}

export function SettingsPage() {
  const { isAdmin, sessionFetch } = useSession();
  const resource = useAdminResource<SettingsPayload>("/api/admin/settings");
  const accountsResource = useAdminResource<{ accounts?: MirrorAccount[] }>("/api/admin/mirror-accounts");
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [oneTimeCronSecret, setOneTimeCronSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [stripDialogOpen, setStripDialogOpen] = useState(false);
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
    if (
      !window.confirm(
        name === "api_key_pepper"
          ? "轮换 API Key Pepper 会使现有 API 密钥全部失效。继续？"
          : "轮换后外部定时任务需要使用新密钥。继续？",
      )
    )
      return;
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
              <Field label="域名镜像路由" description="每个原始域名可配置多个镜像。选择顺序固定为：账号指定 > 正则规则 > 按账号 ID Hash 分片。">
                <DomainMirrorsEditor value={form.domainMirrorMap} accounts={accountsResource.data?.accounts ?? []} onChange={(value) => update("domainMirrorMap", value)} />
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
          <div className="break-all rounded-md border bg-[#fafafa] p-3 font-mono text-xs leading-5">{oneTimeCronSecret}</div>
          <Button variant="outline" className="w-full" onClick={async () => { if (!oneTimeCronSecret) return; await navigator.clipboard.writeText(oneTimeCronSecret); setCopied(true); }}>
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

function DomainMirrorsEditor({ value, accounts, onChange }: { value: DomainMirrorMap; accounts: MirrorAccount[]; onChange: (value: DomainMirrorMap) => void }) {
  const groups = collectMirrorGroups(value);
  const [editingGroup, setEditingGroup] = useState<MirrorGroup | null | undefined>(undefined);
  function removeGroup(id: string) {
    if (!window.confirm("确定删除这个镜像组吗？组内的域名、规则和账号绑定会一起移除。")) return;
    onChange(removeMirrorGroup(value, id));
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-start gap-3">
      <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">镜像按组管理，每组包含多个原始域名和一个镜像地址。<code className="text-foreground">$host</code> 会替换为原始请求 host；账号绑定优先于正则规则，最后按账号 ID 做稳定 Hash 分片。</p>
      <Button type="button" size="sm" onClick={() => setEditingGroup(null)}><Plus />新增镜像组</Button>
    </div>
    {groups.length ? <div className="space-y-2">
      {groups.map((group) => <div key={group.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border bg-white px-3 py-3">
        <div className="min-w-48 flex-1">
          <div className="flex items-center gap-2"><p className="text-sm font-medium">{group.name}</p><span className={`rounded-full px-2 py-0.5 text-[10px] ${group.enabled ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>{group.enabled ? "启用" : "停用"}</span></div>
          <code className="mt-1 block truncate text-[11px] text-muted-foreground">{group.url}</code>
        </div>
        <div className="text-right text-[11px] leading-5 text-muted-foreground"><p>{group.domains.length} 个域名 · {group.accountIds.length} 个账号 · {group.rules.length} 条规则</p><p className="max-w-80 truncate font-mono">{group.domains.join(", ")}</p></div>
        <div className="flex gap-1"><Button type="button" variant="outline" size="sm" onClick={() => setEditingGroup(group)}>编辑</Button><Button type="button" variant="ghost" size="icon-sm" className="text-destructive" onClick={() => removeGroup(group.id)}><Trash2 /></Button></div>
      </div>)}
    </div> : <div className="rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">暂无镜像组</div>}
    {editingGroup !== undefined ? <MirrorGroupDialog key={editingGroup?.id ?? "new"} group={editingGroup} value={value} accounts={accounts} onClose={() => setEditingGroup(undefined)} onSave={(group) => { onChange(saveMirrorGroup(value, group, editingGroup?.id)); setEditingGroup(undefined); }} /> : null}
  </div>;
}

function collectMirrorGroups(value: DomainMirrorMap): MirrorGroup[] {
  const groups = new Map<string, MirrorGroup>();
  const ruleKeys = new Map<string, Set<string>>();
  for (const [domain, config] of Object.entries(value)) {
    for (const mirror of config.mirrors) {
      const group = groups.get(mirror.id) ?? { ...mirror, domains: [], accountIds: [], rules: [] };
      if (!group.domains.includes(domain)) group.domains.push(domain);
      for (const [accountId, mirrorId] of Object.entries(config.accountAssignments)) {
        if (mirrorId === mirror.id && !group.accountIds.includes(accountId)) group.accountIds.push(accountId);
      }
      const seen = ruleKeys.get(mirror.id) ?? new Set<string>();
      for (const rule of config.rules.filter((item) => item.mirrorId === mirror.id)) {
        const key = `${rule.pattern}\u0000${rule.enabled}`;
        if (!seen.has(key)) { group.rules.push({ id: rule.id, pattern: rule.pattern, enabled: rule.enabled }); seen.add(key); }
      }
      ruleKeys.set(mirror.id, seen);
      groups.set(mirror.id, group);
    }
  }
  return [...groups.values()].map((group) => ({ ...group, domains: group.domains.sort(), accountIds: group.accountIds.sort() }));
}

function cloneMirrorMap(value: DomainMirrorMap): DomainMirrorMap {
  return Object.fromEntries(Object.entries(value).map(([domain, config]) => [domain, { mirrors: config.mirrors.map((mirror) => ({ ...mirror })), accountAssignments: { ...config.accountAssignments }, rules: config.rules.map((rule) => ({ ...rule })) }]));
}

function removeMirrorGroup(value: DomainMirrorMap, id: string): DomainMirrorMap {
  const next = cloneMirrorMap(value);
  for (const [domain, config] of Object.entries(next)) {
    config.mirrors = config.mirrors.filter((mirror) => mirror.id !== id);
    config.rules = config.rules.filter((rule) => rule.mirrorId !== id);
    config.accountAssignments = Object.fromEntries(Object.entries(config.accountAssignments).filter(([, mirrorId]) => mirrorId !== id));
    if (!config.mirrors.length && !config.rules.length && !Object.keys(config.accountAssignments).length) delete next[domain];
  }
  return next;
}

function saveMirrorGroup(value: DomainMirrorMap, group: MirrorGroup, previousId?: string): DomainMirrorMap {
  const next = removeMirrorGroup(value, previousId ?? group.id);
  for (const domain of group.domains) {
    const config = next[domain] ?? { mirrors: [], accountAssignments: {}, rules: [] };
    config.mirrors.push({ id: group.id, name: group.name, url: group.url, enabled: group.enabled });
    config.rules.push(...group.rules.map((rule, index) => ({ ...rule, id: `${group.id}_rule_${index}`, mirrorId: group.id })));
    for (const accountId of group.accountIds) config.accountAssignments[accountId] = group.id;
    next[domain] = config;
  }
  return next;
}

function MirrorGroupDialog({ group, value, accounts, onClose, onSave }: { group: MirrorGroup | null; value: DomainMirrorMap; accounts: MirrorAccount[]; onClose: () => void; onSave: (group: MirrorGroup) => void }) {
  const presetDomains = PROVIDER_DOMAIN_PRESETS.flatMap((item) => item.domains);
  const [name, setName] = useState(group?.name ?? "");
  const [url, setUrl] = useState(group?.url ?? "");
  const [enabled, setEnabled] = useState(group?.enabled ?? true);
  const [domains, setDomains] = useState<Set<string>>(new Set(group?.domains ?? []));
  const [customDomains, setCustomDomains] = useState<string[]>(group?.domains.filter((domain) => !presetDomains.some((item) => item.domain === domain)) ?? []);
  const [customDomain, setCustomDomain] = useState("");
  const [rules, setRules] = useState<Array<Omit<MirrorRule, "mirrorId">>>(group?.rules ?? []);
  const [pattern, setPattern] = useState("");
  const [accountIds, setAccountIds] = useState<Set<string>>(new Set(group?.accountIds ?? []));
  const [query, setQuery] = useState("");
  const knownDomains = [...new Set([...presetDomains.map((item) => item.domain), ...Object.keys(value), ...customDomains])];
  const filteredAccounts = useMemo(() => { const q = query.trim().toLowerCase(); return accounts.filter((account) => !q || [account.name, account.email, account.id, account.workspaceId, account.poolType].some((item) => String(item || "").toLowerCase().includes(q))).slice(0, 100); }, [accounts, query]);
  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) { setter((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function addCustomDomain() {
    const domain = customDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!domain) return;
    setCustomDomains((current) => current.includes(domain) ? current : [...current, domain]);
    setDomains((current) => new Set([...current, domain])); setCustomDomain("");
  }
  const valid = name.trim() && url.trim() && domains.size;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{group ? "编辑镜像组" : "新增镜像组"}</DialogTitle><DialogDescription>整组管理镜像地址、原始域名、匹配规则和指定账号。镜像地址可使用 $host。</DialogDescription></DialogHeader>
    <div className="space-y-5 py-1">
      <div className="grid gap-3 sm:grid-cols-[160px_1fr]"><Field label="组名称"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 Ahao 镜像" /></Field><Field label="镜像地址" description="例如 https://mirror.ahao1.tech/$host"><Input className="font-mono" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mirror.ahao1.tech/$host" /></Field></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用这个镜像组</label>
      <Field label={`原始域名（已选 ${domains.size} 个）`} description="一组可以包含多个需要代理的原始域名。"><div className="grid max-h-44 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">{knownDomains.map((domain) => { const preset = presetDomains.find((item) => item.domain === domain); return <label key={domain} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[#fafafa]"><input type="checkbox" checked={domains.has(domain)} onChange={() => toggle(setDomains, domain)} /><span className="min-w-0 truncate font-mono">{domain}</span>{preset ? <span className="ml-auto truncate text-[10px] text-muted-foreground">{preset.label}</span> : null}</label>; })}</div><div className="mt-2 flex gap-2"><Input className="h-8 flex-1 font-mono text-xs" value={customDomain} onChange={(event) => setCustomDomain(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomDomain(); } }} placeholder="其他域名，例如 custom.example.com" /><Button type="button" variant="outline" size="sm" onClick={addCustomDomain} disabled={!customDomain.trim()}>添加</Button></div></Field>
      <Field label={`正则规则（${rules.length} 条）`} description="匹配账号名称、邮箱、ID、工作区或账号池；账号指定的优先级更高。"><div className="space-y-2">{rules.map((rule) => <div key={rule.id} className="grid grid-cols-[28px_1fr_34px] gap-2"><input type="checkbox" checked={rule.enabled} onChange={(event) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item))} /><Input className="h-8 font-mono text-xs" value={rule.pattern} onChange={(event) => setRules((current) => current.map((item) => item.id === rule.id ? { ...item, pattern: event.target.value } : item))} /><Button type="button" variant="ghost" size="icon-sm" onClick={() => setRules((current) => current.filter((item) => item.id !== rule.id))}><Trash2 /></Button></div>)}<div className="flex gap-2"><Input className="h-8 flex-1 font-mono text-xs" value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="例如 @example\\.com$ 或 ^prod-" /><Button type="button" variant="outline" size="sm" disabled={!pattern.trim()} onClick={() => { setRules((current) => [...current, { id: newId("rule"), pattern: pattern.trim(), enabled: true }]); setPattern(""); }}><Plus />规则</Button></div></div></Field>
      <Field label={`指定账号（已选 ${accountIds.size} 个）`} description="这些账号始终使用本组镜像；未指定账号继续走规则或稳定 Hash。"><Input className="mb-2 h-8 text-xs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号" /><div className="max-h-44 overflow-y-auto rounded-md border">{filteredAccounts.map((account) => <label key={account.id} className="flex items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0"><input type="checkbox" checked={accountIds.has(account.id)} onChange={() => toggle(setAccountIds, account.id)} /><span className="min-w-0 flex-1 truncate">{account.name || account.email || account.id}</span><span className="text-[11px] text-muted-foreground">{account.poolType}</span></label>)}</div></Field>
    </div>
    <DialogFooter><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="button" disabled={!valid} onClick={() => onSave({ id: group?.id ?? newId("mirror"), name: name.trim(), url: url.trim(), enabled, domains: [...domains], accountIds: [...accountIds], rules })}>保存镜像组</Button></DialogFooter>
  </DialogContent></Dialog>;
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
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4"
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
