"use client";

import { useMemo, useState } from "react";
import { Braces, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAdmin } from "./admin-context";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, formatDate } from "./page-kit";
import { useAdminResource } from "./use-admin-resource";

type InterfaceType = "chat" | "responses";
interface BalanceConfig { request: { url: string; method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown }; extractor: string }
interface CustomProvider {
  id: string; poolType: string; name: string; description: string; baseUrl: string; interfaceType: InterfaceType;
  models: string[] | null; balanceConfig: BalanceConfig | null; enabled: boolean; createdAt: string; updatedAt: string;
}
interface ProviderKey { id: string; name: string; adminState: "ENABLED" | "DISABLED"; authState: string; maxConcurrency: number; lastSuccessAt: string | null; createdAt: string }

const DEFAULT_EXTRACTOR = `function(response) {
  return {
    isValid: response.is_active !== false,
    remaining: response.balance,
    total: response.total,
    type: "permanent",
    unit: "USD"
  };
}`;

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as { error?: { message?: unknown }; message?: unknown };
  if (typeof value.error?.message === "string") return value.error.message;
  return typeof value.message === "string" ? value.message : fallback;
}

export function CustomProvidersPage() {
  const { adminFetch } = useAdmin();
  const resource = useAdminResource<{ providers: CustomProvider[] }>("/api/admin/custom-providers");
  const providers = resource.data?.providers ?? [];
  const [editing, setEditing] = useState<CustomProvider | null | undefined>(undefined);
  const [keyProvider, setKeyProvider] = useState<CustomProvider | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function remove(provider: CustomProvider) {
    if (!window.confirm(`确认删除 Provider「${provider.name}」？其下全部 API Key 账号、额度记录和模型缓存会一并删除，此操作不可恢复。`)) return;
    setBusyId(provider.id); setMessage(null);
    try {
      const response = await adminFetch(`/api/admin/custom-providers/${provider.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(errorMessage(await response.json().catch(() => null), "删除失败"));
      if (keyProvider?.id === provider.id) setKeyProvider(null);
      setMessage(`已删除 ${provider.name}`);
      await resource.refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "删除失败"); }
    finally { setBusyId(null); }
  }

  async function refreshModels(provider: CustomProvider) {
    setBusyId(provider.id); setMessage(null);
    try {
      const response = await adminFetch("/api/admin/provider-models", { method: "POST", body: JSON.stringify({ poolType: provider.poolType }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "拉取模型失败"));
      setMessage(`已为 ${provider.name} 拉取 ${payload?.catalog?.models?.length ?? 0} 个模型`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "拉取模型失败"); }
    finally { setBusyId(null); }
  }

  return (
    <>
      <PageIntro eyebrow="CUSTOM UPSTREAMS" title="自定义 Provider" description="配置 OpenAI 兼容上游、接口类型和 API Key。未填写模型列表时，系统从上游 /models 自动发现。" actions={<Button size="sm" onClick={() => setEditing(null)}><Plus data-icon="inline-start" />新建 Provider</Button>} />
      {message ? <p className="mb-4 rounded-md border bg-white px-3 py-2 text-xs text-muted-foreground" role="status">{message}</p> : null}
      {resource.error ? <Panel><ErrorState message={resource.error} onRetry={() => void resource.refresh()} /></Panel> : null}
      {!resource.error ? <Panel title="Provider 列表" description={`${providers.length} 个自定义上游；停用后其全部 Key 立即退出调度。`}>
        {resource.loading ? <LoadingTable rows={4} columns={5} /> : providers.length ? (
          <div className="divide-y">
            {providers.map((provider) => (
              <div key={provider.id} className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(180px,1fr)_minmax(240px,1.4fr)_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><p className="truncate text-sm font-medium">{provider.name}</p><span className={`rounded-sm px-1.5 py-0.5 text-[10px] ${provider.enabled ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>{provider.enabled ? "ACTIVE" : "DISABLED"}</span></div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{provider.description || "无描述"}</p>
                </div>
                <div className="min-w-0 text-xs">
                  <p className="truncate font-mono text-foreground">{provider.baseUrl}</p>
                  <p className="mt-1 text-muted-foreground">{provider.interfaceType === "chat" ? "Chat Completions" : "Responses"} · {provider.models?.length ? `${provider.models.length} 个固定模型` : "从 /models 自动发现"} · {provider.balanceConfig ? "已配置余额查询" : "未配置余额查询"}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setKeyProvider(provider)}><KeyRound />API Keys</Button>
                  {!provider.models?.length ? <Button variant="outline" size="sm" disabled={busyId === provider.id} onClick={() => void refreshModels(provider)}><RefreshCw className={busyId === provider.id ? "animate-spin" : ""} />模型</Button> : null}
                  <Button variant="outline" size="icon-sm" aria-label={`编辑 ${provider.name}`} onClick={() => setEditing(provider)}><Pencil /></Button>
                  <Button variant="outline" size="icon-sm" className="text-destructive" disabled={busyId === provider.id} aria-label={`删除 ${provider.name}`} onClick={() => void remove(provider)}><Trash2 /></Button>
                </div>
              </div>
            ))}
          </div>
        ) : <EmptyState title="还没有自定义 Provider" description="创建后添加一个或多个 API Key，即可进入现有模型路由和账号调度。" action={<Button size="sm" onClick={() => setEditing(null)}><Plus />新建 Provider</Button>} />}
      </Panel> : null}

      <BalanceDocumentation />
      {editing !== undefined ? <ProviderEditor provider={editing} onClose={() => setEditing(undefined)} onSaved={async () => { setEditing(undefined); await resource.refresh(); }} /> : null}
      {keyProvider ? <KeyManager provider={keyProvider} onClose={() => setKeyProvider(null)} adminFetch={adminFetch} /> : null}
    </>
  );
}

function ProviderEditor({ provider, onClose, onSaved }: { provider: CustomProvider | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { adminFetch } = useAdmin();
  const [name, setName] = useState(provider?.name ?? "");
  const [description, setDescription] = useState(provider?.description ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [interfaceType, setInterfaceType] = useState<InterfaceType>(provider?.interfaceType ?? "responses");
  const [models, setModels] = useState(provider?.models?.join("\n") ?? "");
  const [balanceEnabled, setBalanceEnabled] = useState(Boolean(provider?.balanceConfig));
  const [balanceUrl, setBalanceUrl] = useState(provider?.balanceConfig?.request.url ?? "{{baseUrl}}/user/balance");
  const [balanceMethod, setBalanceMethod] = useState<"GET" | "POST">(provider?.balanceConfig?.request.method ?? "GET");
  const [balanceHeaders, setBalanceHeaders] = useState(JSON.stringify(provider?.balanceConfig?.request.headers ?? { Authorization: "Bearer {{apiKey}}" }, null, 2));
  const [balanceBody, setBalanceBody] = useState(provider?.balanceConfig?.request.body === undefined ? "" : JSON.stringify(provider.balanceConfig.request.body, null, 2));
  const [extractor, setExtractor] = useState(provider?.balanceConfig?.extractor ?? DEFAULT_EXTRACTOR);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true); setError(null);
    try {
      let headers: Record<string, string> = {};
      if (balanceEnabled) {
        const parsed = JSON.parse(balanceHeaders) as unknown;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("余额请求 Headers 必须是 JSON 对象");
        headers = parsed as Record<string, string>;
      }
      const requestBody = balanceEnabled && balanceBody.trim() ? JSON.parse(balanceBody) : undefined;
      const payload = {
        name, description, baseUrl, interfaceType, enabled,
        models: models.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean),
        balanceConfig: balanceEnabled ? { request: { url: balanceUrl, method: balanceMethod, headers, ...(requestBody === undefined ? {} : { body: requestBody }) }, extractor } : null,
      };
      const response = await adminFetch(provider ? `/api/admin/custom-providers/${provider.id}` : "/api/admin/custom-providers", { method: provider ? "PATCH" : "POST", body: JSON.stringify(payload) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "保存失败"));
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
    <DialogHeader><DialogTitle>{provider ? "编辑 Provider" : "新建 Provider"}</DialogTitle><DialogDescription>base URL 应包含 API 版本路径，例如 https://api.example.com/v1。</DialogDescription></DialogHeader>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="名称"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Internal OpenAI" /></Field>
      <Field label="接口类型"><select className="h-9 w-full rounded-md border bg-white px-3 text-sm" value={interfaceType} onChange={(event) => setInterfaceType(event.target.value as InterfaceType)}><option value="responses">Responses API</option><option value="chat">Chat Completions API</option></select></Field>
      <Field label="Base URL" wide><Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></Field>
      <Field label="描述" wide><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途、地域或计费说明" /></Field>
      <Field label="模型列表（每行一个，留空自动拉取 /models）" wide><Textarea className="min-h-24 font-mono text-xs" value={models} onChange={(event) => setModels(event.target.value)} placeholder={"gpt-5.6\nclaude-sonnet-4.5"} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用 Provider</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={balanceEnabled} onChange={(event) => setBalanceEnabled(event.target.checked)} />配置余额查询</label>
      {balanceEnabled ? <>
        <Field label="余额接口 URL" wide><Input className="font-mono text-xs" value={balanceUrl} onChange={(event) => setBalanceUrl(event.target.value)} /></Field>
        <Field label="请求方法"><select className="h-9 w-full rounded-md border bg-white px-3 text-sm" value={balanceMethod} onChange={(event) => setBalanceMethod(event.target.value as "GET" | "POST")}><option>GET</option><option>POST</option></select></Field>
        <Field label="Headers JSON"><Textarea className="min-h-28 font-mono text-xs" value={balanceHeaders} onChange={(event) => setBalanceHeaders(event.target.value)} /></Field>
        <Field label="Body JSON（可选）"><Textarea className="min-h-28 font-mono text-xs" value={balanceBody} onChange={(event) => setBalanceBody(event.target.value)} placeholder={'{"scope":"billing"}'} /></Field>
        <Field label="Extractor 函数" wide><Textarea className="min-h-56 font-mono text-xs" value={extractor} onChange={(event) => setExtractor(event.target.value)} /></Field>
      </> : null}
    </div>
    {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
    <DialogFooter><Button variant="outline" onClick={onClose} disabled={saving}>取消</Button><Button onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="animate-spin" /> : null}保存</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function KeyManager({ provider, onClose, adminFetch }: { provider: CustomProvider; onClose: () => void; adminFetch: (path: string, init?: RequestInit) => Promise<Response> }) {
  const resource = useAdminResource<{ keys: ProviderKey[] }>(`/api/admin/custom-providers/${provider.id}/keys`);
  const [name, setName] = useState(""); const [apiKey, setApiKey] = useState(""); const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState<ProviderKey | null>(null); const [replacementKey, setReplacementKey] = useState("");
  const keys = resource.data?.keys ?? [];
  async function create() {
    setSaving(true); setError(null);
    try {
      const response = await adminFetch(`/api/admin/custom-providers/${provider.id}/keys`, { method: "POST", body: JSON.stringify({ name, apiKey, maxConcurrency }) });
      const payload = await response.json().catch(() => null); if (!response.ok) throw new Error(errorMessage(payload, "添加失败"));
      const warnings = payload && typeof payload === "object" && Array.isArray((payload as { warnings?: unknown }).warnings) ? (payload as { warnings: string[] }).warnings : [];
      setNotice(warnings.length ? `Key 已保存；上游探测提示：${warnings.join("；")}` : "API Key 已添加并完成上游探测");
      setName(""); setApiKey(""); await resource.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "添加失败"); } finally { setSaving(false); }
  }
  async function patch(key: ProviderKey, input: object) {
    const response = await adminFetch(`/api/admin/custom-providers/${provider.id}/keys/${key.id}`, { method: "PATCH", body: JSON.stringify(input) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(payload, "更新失败"));
    const warnings = payload && typeof payload === "object" && Array.isArray((payload as { warnings?: unknown }).warnings) ? (payload as { warnings: string[] }).warnings : [];
    setNotice(warnings.length ? `配置已保存；上游探测提示：${warnings.join("；")}` : "配置已更新");
    await resource.refresh();
  }
  async function remove(key: ProviderKey) {
    if (!window.confirm(`确认删除 API Key「${key.name}」？此操作不可恢复。`)) return;
    const response = await adminFetch(`/api/admin/custom-providers/${provider.id}/keys/${key.id}`, { method: "DELETE" });
    if (!response.ok) setError(errorMessage(await response.json().catch(() => null), "删除失败")); else await resource.refresh();
  }
  async function replaceKey() {
    if (!rotating || !replacementKey.trim()) return;
    setSaving(true); setError(null);
    try { await patch(rotating, { apiKey: replacementKey }); setRotating(null); setReplacementKey(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "更换失败"); }
    finally { setSaving(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{provider.name} · API Keys</DialogTitle><DialogDescription>每个 Key 是独立调度账号，可单独停用并配置并发上限。密钥写入后不再回显。</DialogDescription></DialogHeader>
    <div className="grid gap-3 rounded-md border bg-[#fafafa] p-3 sm:grid-cols-[1fr_1.4fr_100px_auto]">
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Key 名称" />
      <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." />
      <Input type="number" min={1} max={64} value={maxConcurrency} onChange={(event) => setMaxConcurrency(Number(event.target.value))} />
      <Button onClick={() => void create()} disabled={saving || !name.trim() || !apiKey.trim()}>{saving ? <LoaderCircle className="animate-spin" /> : <Plus />}添加</Button>
    </div>
    {error ? <p className="text-xs text-destructive">{error}</p> : null}
    {notice ? <p className="text-xs text-muted-foreground" role="status">{notice}</p> : null}
    {resource.loading ? <LoadingTable rows={3} columns={4} /> : keys.length ? <div className="divide-y rounded-md border">
      {keys.map((key) => <div key={key.id} className="grid gap-2 px-3 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
        <div><p className="text-sm font-medium">{key.name}</p><p className="mt-1 text-[11px] text-muted-foreground">并发 {key.maxConcurrency} · 最近成功 {formatDate(key.lastSuccessAt)} · {key.authState}</p></div>
        <div className="flex gap-1"><Button variant="outline" size="sm" onClick={() => void patch(key, { enabled: key.adminState !== "ENABLED" })}>{key.adminState === "ENABLED" ? "停用" : "启用"}</Button><Button variant="outline" size="sm" onClick={() => { setRotating(key); setReplacementKey(""); }}><RefreshCw />更换</Button></div>
        <Button variant="outline" size="icon-sm" className="text-destructive" onClick={() => void remove(key)}><Trash2 /></Button>
      </div>)}
    </div> : <p className="py-8 text-center text-sm text-muted-foreground">尚未添加 API Key</p>}
    {rotating ? <div className="flex flex-wrap items-center gap-2 rounded-md border bg-[#fafafa] p-3"><span className="text-xs">更换 {rotating.name}</span><Input type="password" className="min-w-56 flex-1" value={replacementKey} onChange={(event) => setReplacementKey(event.target.value)} placeholder="新的 API Key" /><Button variant="outline" size="sm" onClick={() => setRotating(null)}>取消</Button><Button size="sm" disabled={saving || !replacementKey.trim()} onClick={() => void replaceKey()}>保存新密钥</Button></div> : null}
  </DialogContent></Dialog>;
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <div className={wide ? "sm:col-span-2" : ""}><Label className="mb-1.5">{label}</Label>{children}</div>;
}

function BalanceDocumentation() {
  const kinds = useMemo(() => [
    ["permanent", "永久余额", "不自动恢复；remaining ≤ 0 时退出调度。"],
    ["5h", "5 小时窗口", "映射为 FIVE_HOUR。建议返回 resetAt。"],
    ["weekly", "周窗口", "映射为 WEEKLY。"],
    ["monthly", "月窗口", "映射为 MONTHLY。"],
    ["period", "自定义周期", "映射为 CUSTOM_PERIOD；可用 resetAt 或 periodSeconds。"],
  ], []);
  return <Panel className="mt-4" title="余额脚本协议" description="请求模板支持 {{baseUrl}} 与 {{apiKey}}；extractor 在无网络、无模块加载能力的受限上下文中执行，单次最多 100ms。" action={<Braces className="size-4 text-muted-foreground" />}>
    <div className="grid gap-5 p-4 sm:p-5 xl:grid-cols-2">
      <div className="space-y-3 text-xs leading-5 text-muted-foreground">
        <p className="font-medium text-foreground">请求配置</p>
        <p><code className="text-foreground">request.url</code> 必填；可在任意位置使用模板变量。<code className="text-foreground">method</code> 支持 GET/POST，<code className="text-foreground">headers</code> 是字符串键值对象，<code className="text-foreground">body</code> 可为字符串或 JSON。</p>
        <p className="font-medium text-foreground">Extractor 返回值</p>
        <p><code className="text-foreground">isValid</code> 可选，严格等于 false 表示 Key 无效；<code className="text-foreground">remaining</code> 必填；<code className="text-foreground">total</code> 可选，用于计算 usagePercent；<code className="text-foreground">unit</code> 用于展示；<code className="text-foreground">type</code> 指定周期。</p>
        <p>同时返回多个窗口时使用 <code className="text-foreground">windows: [...]</code>。每项字段与单窗口相同。调度会在任一有效窗口耗尽时暂时排除该 Key。</p>
      </div>
      <div className="overflow-hidden rounded-md border">
        {kinds.map(([kind, label, description]) => <div key={kind} className="grid grid-cols-[90px_100px_1fr] gap-2 border-b px-3 py-2 text-xs last:border-b-0"><code>{kind}</code><span>{label}</span><span className="text-muted-foreground">{description}</span></div>)}
      </div>
    </div>
  </Panel>;
}
