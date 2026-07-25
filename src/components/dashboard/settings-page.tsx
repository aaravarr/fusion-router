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
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(new Set());
  const [customDomain, setCustomDomain] = useState("");
  const [mirrorName, setMirrorName] = useState("");
  const [mirrorUrl, setMirrorUrl] = useState("");
  const presetDomains = PROVIDER_DOMAIN_PRESETS.flatMap((group) => group.domains);
  const knownDomains = [...new Set([...presetDomains.map((item) => item.domain), ...Object.keys(value)])];
  function toggleDomain(domain: string) {
    setSelectedDomains((current) => { const next = new Set(current); if (next.has(domain)) next.delete(domain); else next.add(domain); return next; });
  }
  function addCustomDomain() {
    const normalized = customDomain.trim().toLowerCase();
    if (!normalized) return;
    setSelectedDomains((current) => new Set([...current, normalized]));
    setCustomDomain("");
  }
  function addBatchMirror() {
    if (!selectedDomains.size || !mirrorName.trim() || !mirrorUrl.trim()) return;
    const id = newId("mirror");
    const next = { ...value };
    for (const domain of selectedDomains) {
      const config = next[domain] ?? { mirrors: [], accountAssignments: {}, rules: [] };
      const normalizedUrl = mirrorUrl.trim().replace(/\/$/, "");
      next[domain] = config.mirrors.some((mirror) => mirror.url.replace(/\/$/, "") === normalizedUrl)
        ? config
        : { ...config, mirrors: [...config.mirrors, { id, name: mirrorName.trim(), url: mirrorUrl.trim(), enabled: true }] };
    }
    onChange(next);
    setSelectedDomains(new Set()); setMirrorName(""); setMirrorUrl("");
  }
  return <div className="space-y-3">
    <p className="text-xs leading-5 text-muted-foreground">先多选需要代理的原始域名，再添加一组镜像。镜像地址中的 <code className="text-foreground">$host</code> 会替换为当前请求的原始 host，例如 <code className="text-foreground">https://mirror.ahao1.tech/$host</code>。显式账号绑定优先于正则规则，最后按账号 ID 做稳定 Hash 分片。</p>
    <div className="space-y-3 rounded-md border bg-[#fafafa] p-3">
      <div className="flex flex-wrap items-center gap-2"><p className="mr-auto text-xs font-medium">批量选择原始域名</p><span className="text-[11px] text-muted-foreground">已选 {selectedDomains.size} 个</span><Button type="button" variant="ghost" size="sm" onClick={() => setSelectedDomains(new Set(knownDomains))}>全选</Button><Button type="button" variant="ghost" size="sm" onClick={() => setSelectedDomains(new Set())}>清空</Button></div>
      <div className="grid max-h-48 gap-1 overflow-y-auto rounded-md border bg-white p-2 sm:grid-cols-2 xl:grid-cols-3">
        {knownDomains.map((hostname) => { const preset = presetDomains.find((item) => item.domain === hostname); return <label key={hostname} className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[#fafafa]"><input type="checkbox" checked={selectedDomains.has(hostname)} onChange={() => toggleDomain(hostname)} /><span className="min-w-0 truncate font-mono">{hostname}</span>{preset ? <span className="ml-auto truncate text-[10px] text-muted-foreground">{preset.label}</span> : null}</label>; })}
      </div>
      <div className="flex gap-2"><Input className="h-8 flex-1 font-mono text-xs" value={customDomain} onChange={(event) => setCustomDomain(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomDomain(); } }} placeholder="其他域名，例如 custom.example.com" /><Button type="button" variant="outline" size="sm" disabled={!customDomain.trim()} onClick={addCustomDomain}>加入选择</Button></div>
      <div className="grid gap-2 border-t border-dashed pt-3 sm:grid-cols-[140px_1fr_auto]"><Input className="h-8 text-xs" value={mirrorName} onChange={(event) => setMirrorName(event.target.value)} placeholder="镜像名称" /><Input className="h-8 font-mono text-xs" value={mirrorUrl} onChange={(event) => setMirrorUrl(event.target.value)} placeholder="https://mirror.ahao1.tech/$host" /><Button type="button" size="sm" disabled={!selectedDomains.size || !mirrorName.trim() || !mirrorUrl.trim()} onClick={addBatchMirror}><Plus />批量添加</Button></div>
    </div>
    {Object.entries(value).map(([hostname, config]) => <DomainMirrorCard key={hostname} domain={hostname} config={config} accounts={accounts} onChange={(next) => onChange({ ...value, [hostname]: next })} onDelete={() => { const next = { ...value }; delete next[hostname]; onChange(next); }} />)}
  </div>;
}

function DomainMirrorCard({ domain, config, accounts, onChange, onDelete }: { domain: string; config: DomainMirrorConfig; accounts: MirrorAccount[]; onChange: (value: DomainMirrorConfig) => void; onDelete: () => void }) {
  const [mirrorName, setMirrorName] = useState(""); const [mirrorUrl, setMirrorUrl] = useState("");
  const [pattern, setPattern] = useState(""); const [ruleMirrorId, setRuleMirrorId] = useState("");
  function patchMirror(id: string, patch: Partial<MirrorTarget>) { onChange({ ...config, mirrors: config.mirrors.map((item) => item.id === id ? { ...item, ...patch } : item) }); }
  function removeMirror(id: string) {
    onChange({ mirrors: config.mirrors.filter((item) => item.id !== id), rules: config.rules.filter((rule) => rule.mirrorId !== id), accountAssignments: Object.fromEntries(Object.entries(config.accountAssignments).filter(([, mirrorId]) => mirrorId !== id)) });
  }
  return <div className="overflow-hidden rounded-md border bg-white">
    <div className="flex items-center gap-3 border-b bg-[#fafafa] px-3 py-2"><code className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{domain}</code><span className="text-[11px] text-muted-foreground">{config.mirrors.filter((item) => item.enabled).length} 个启用镜像</span><Button type="button" variant="ghost" size="icon-sm" className="text-destructive" onClick={onDelete}><Trash2 /></Button></div>
    <div className="space-y-4 p-3">
      <div className="space-y-2"><p className="text-xs font-medium">镜像节点</p>
        {config.mirrors.map((mirror) => <div key={mirror.id} className="grid gap-2 sm:grid-cols-[28px_130px_1fr_34px]">
          <input type="checkbox" checked={mirror.enabled} onChange={(event) => patchMirror(mirror.id, { enabled: event.target.checked })} aria-label={`启用 ${mirror.name}`} />
          <Input className="h-8 text-xs" value={mirror.name} onChange={(event) => patchMirror(mirror.id, { name: event.target.value })} />
          <Input className="h-8 font-mono text-xs" value={mirror.url} onChange={(event) => patchMirror(mirror.id, { url: event.target.value })} />
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeMirror(mirror.id)}><Trash2 /></Button>
        </div>)}
        <div className="grid gap-2 sm:grid-cols-[130px_1fr_auto]"><Input className="h-8 text-xs" value={mirrorName} onChange={(event) => setMirrorName(event.target.value)} placeholder="节点名称" /><Input className="h-8 font-mono text-xs" value={mirrorUrl} onChange={(event) => setMirrorUrl(event.target.value)} placeholder="https://mirror.ahao1.tech/$host" /><Button type="button" variant="outline" size="sm" disabled={!mirrorName.trim() || !mirrorUrl.trim()} onClick={() => { onChange({ ...config, mirrors: [...config.mirrors, { id: newId("mirror"), name: mirrorName.trim(), url: mirrorUrl.trim(), enabled: true }] }); setMirrorName(""); setMirrorUrl(""); }}><Plus />节点</Button></div>
      </div>
      {config.mirrors.length ? <>
        <div className="space-y-2"><p className="text-xs font-medium">正则规则 <span className="font-normal text-muted-foreground">（按列表顺序，优先级低于账号绑定）</span></p>
          {config.rules.map((rule) => <div key={rule.id} className="grid gap-2 sm:grid-cols-[28px_1fr_150px_34px]"><input type="checkbox" checked={rule.enabled} onChange={(event) => onChange({ ...config, rules: config.rules.map((item) => item.id === rule.id ? { ...item, enabled: event.target.checked } : item) })} /><Input className="h-8 font-mono text-xs" value={rule.pattern} onChange={(event) => onChange({ ...config, rules: config.rules.map((item) => item.id === rule.id ? { ...item, pattern: event.target.value } : item) })} /><MirrorSelect mirrors={config.mirrors} value={rule.mirrorId} onChange={(mirrorId) => onChange({ ...config, rules: config.rules.map((item) => item.id === rule.id ? { ...item, mirrorId } : item) })} /><Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange({ ...config, rules: config.rules.filter((item) => item.id !== rule.id) })}><Trash2 /></Button></div>)}
          <div className="grid gap-2 sm:grid-cols-[1fr_150px_auto]"><Input className="h-8 font-mono text-xs" value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="例如 @example\\.com$ 或 ^prod-" /><MirrorSelect mirrors={config.mirrors} value={ruleMirrorId} onChange={setRuleMirrorId} /><Button type="button" variant="outline" size="sm" disabled={!pattern || !ruleMirrorId} onClick={() => { onChange({ ...config, rules: [...config.rules, { id: newId("rule"), pattern, mirrorId: ruleMirrorId, enabled: true }] }); setPattern(""); }}><Plus />规则</Button></div>
        </div>
        <AccountMirrorAssignments accounts={accounts} mirrors={config.mirrors} assignments={config.accountAssignments} onChange={(accountAssignments) => onChange({ ...config, accountAssignments })} />
      </> : null}
    </div>
  </div>;
}

function MirrorSelect({ mirrors, value, onChange }: { mirrors: MirrorTarget[]; value: string; onChange: (value: string) => void }) {
  return <select className="h-8 rounded-md border bg-white px-2 text-xs" value={value} onChange={(event) => onChange(event.target.value)}><option value="">选择镜像</option>{mirrors.map((mirror) => <option key={mirror.id} value={mirror.id}>{mirror.name}</option>)}</select>;
}

function AccountMirrorAssignments({ accounts, mirrors, assignments, onChange }: { accounts: MirrorAccount[]; mirrors: MirrorTarget[]; assignments: Record<string, string>; onChange: (value: Record<string, string>) => void }) {
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState<Set<string>>(new Set()); const [mirrorId, setMirrorId] = useState("");
  const filtered = useMemo(() => { const q = query.trim().toLowerCase(); return accounts.filter((account) => !q || [account.name, account.email, account.id, account.workspaceId, account.poolType].some((value) => String(value || "").toLowerCase().includes(q))).slice(0, 100); }, [accounts, query]);
  function apply() { const next = { ...assignments }; for (const id of selected) { if (mirrorId) next[id] = mirrorId; else delete next[id]; } onChange(next); setSelected(new Set()); }
  return <div className="space-y-2"><p className="text-xs font-medium">账号指定 <span className="font-normal text-muted-foreground">（最高优先级，支持多选批量设置）</span></p><div className="flex flex-wrap gap-2"><Input className="h-8 min-w-48 flex-1 text-xs" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号" /><MirrorSelect mirrors={mirrors} value={mirrorId} onChange={setMirrorId} /><Button type="button" variant="outline" size="sm" disabled={!selected.size} onClick={apply}>{mirrorId ? "指定镜像" : "清除指定"} ({selected.size})</Button></div>
    <div className="max-h-44 overflow-y-auto rounded-md border">{filtered.map((account) => { const assigned = mirrors.find((mirror) => mirror.id === assignments[account.id]); return <label key={account.id} className="flex items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0"><input type="checkbox" checked={selected.has(account.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(account.id); else next.delete(account.id); return next; })} /><span className="min-w-0 flex-1 truncate">{account.name || account.email || account.id} <span className="text-muted-foreground">· {account.poolType}</span></span><span className="text-[11px] text-muted-foreground">{assigned?.name ?? "Hash/规则"}</span></label>; })}</div>
  </div>;
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
