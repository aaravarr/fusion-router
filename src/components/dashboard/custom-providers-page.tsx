"use client";

import { useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { Braces, Check, Copy, Info, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { copyToClipboard } from "@/lib/utils";
import { useAdmin } from "./admin-context";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, formatDate } from "./page-kit";
import { useAdminResource } from "./use-admin-resource";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Checkbox } from "@/components/ui/checkbox";

type InterfaceType = "chat" | "responses";
interface BalanceConfig { request: { url: string; method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown }; extractor: string }
interface CustomProvider {
  id: string; poolType: string; name: string; description: string; baseUrl: string; interfaceType: InterfaceType;
  models: string[] | null; balanceConfig: BalanceConfig | null; enabled: boolean; createdAt: string; updatedAt: string; keyCount?: number;
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

const JSON_EDITOR_EXTENSIONS = [json()];
const JAVASCRIPT_EDITOR_EXTENSIONS = [javascript()];

const EXTRACTOR_EXAMPLE = `function(response) {
  return { isValid: response.is_active !== false, remaining: response.balance, total: response.total, type: "permanent", unit: "USD" };
}`;
const DEEPSEEK_BALANCE_EXAMPLE = `function(response) {
  const info = response.balance_infos?.[0] || {};
  return {
    isValid: response.is_available !== false,
    remaining: Number(info.total_balance ?? 0),
    total: null,
    type: "permanent",
    unit: info.currency || "CNY"
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
  const confirm = useConfirm();
  const resource = useAdminResource<{ providers: CustomProvider[] }>("/api/admin/custom-providers");
  const providers = resource.data?.providers ?? [];
  const [editing, setEditing] = useState<CustomProvider | null | undefined>(undefined);
  const [keyProvider, setKeyProvider] = useState<CustomProvider | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function remove(provider: CustomProvider) {
    const approved = await confirm({ title: `删除 Provider“${provider.name}”？`, description: "其下全部 API Key 账号、额度记录和模型缓存会一并删除，此操作不可恢复。", confirmText: "永久删除", destructive: true });
    if (!approved) return;
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
  const [apiKeys, setApiKeys] = useState("");
  const [modelsProbe, setModelsProbe] = useState<{ testing: boolean; result: unknown; error: string | null }>({ testing: false, result: null, error: null });
  const [balanceProbe, setBalanceProbe] = useState<{ testing: boolean; result: unknown; error: string | null }>({ testing: false, result: null, error: null });
  const apiKeyList = apiKeys.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);

  async function save() {
    setSaving(true); setError(null);
    try {
      let headers: Record<string, string> = {};
      if (balanceEnabled) {
        const parsed = JSON.parse(balanceHeaders) as unknown;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("余额请求 Headers 必须是 JSON 对象");
        headers = parsed as Record<string, string>;
      }
      const requestBody = balanceEnabled && balanceMethod === "POST" && balanceBody.trim() ? JSON.parse(balanceBody) : undefined;
      const payload = {
        name, description, baseUrl, interfaceType, enabled,
        apiKeys: apiKeyList,
        models: models.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean),
        balanceConfig: balanceEnabled ? { request: { url: balanceUrl, method: balanceMethod, headers, ...(balanceMethod === "POST" && requestBody !== undefined ? { body: requestBody } : {}) }, extractor } : null,
      };
      const response = await adminFetch(provider ? `/api/admin/custom-providers/${provider.id}` : "/api/admin/custom-providers", { method: provider ? "PATCH" : "POST", body: JSON.stringify(payload) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "保存失败"));
      await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); }
  }

  async function runModelsProbe() {
    if (!apiKeyList.length && !provider) {
      setModelsProbe({ testing: false, result: null, error: "请先填写至少一个 API Key" });
      return;
    }
    setModelsProbe((current) => ({ ...current, testing: true, error: null, result: null }));
    try {
      const payload = { baseUrl, interfaceType, apiKey: apiKeyList[0] || undefined, providerId: provider?.id };
      const response = await adminFetch("/api/admin/custom-providers/test-connection", { method: "POST", body: JSON.stringify(payload) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "调试请求失败"));
      setModelsProbe({ testing: false, result: result && typeof result === "object" ? (result as { result?: unknown }).result : undefined, error: null });
    } catch (cause) {
      setModelsProbe({ testing: false, result: null, error: cause instanceof Error ? cause.message : "调试失败" });
    } finally {
      setModelsProbe((current) => ({ ...current, testing: false }));
    }
  }

  async function runBalanceProbe() {
    try {
      let headers: Record<string, string> = {};
      let requestBody: unknown;
      if (balanceEnabled) {
        const parsed = JSON.parse(balanceHeaders) as unknown;
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("余额请求 Headers 必须是 JSON 对象");
        headers = parsed as Record<string, string>;
        requestBody = balanceMethod === "POST" && balanceBody.trim() ? JSON.parse(balanceBody) : undefined;
      }
      if (!apiKeyList.length && !provider) {
        setBalanceProbe({ testing: false, result: null, error: "请先填写至少一个 API Key" });
        return;
      }
      setBalanceProbe((current) => ({ ...current, testing: true, error: null, result: null }));
      const payload = {
        baseUrl,
        interfaceType,
        apiKey: apiKeyList[0] || undefined,
        providerId: provider?.id,
        extraHeaders: headers,
        balanceConfig: { request: { url: balanceUrl, method: balanceMethod, headers, ...(balanceMethod === "POST" && requestBody !== undefined ? { body: requestBody } : {}) }, extractor },
      };
      const response = await adminFetch("/api/admin/custom-providers/test-connection", { method: "POST", body: JSON.stringify(payload) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "调试请求失败"));
      setBalanceProbe({ testing: false, result: result && typeof result === "object" ? (result as { result?: unknown }).result : undefined, error: null });
    } catch (cause) {
      setBalanceProbe({ testing: false, result: null, error: cause instanceof Error ? cause.message : "调试失败" });
    } finally {
      setBalanceProbe((current) => ({ ...current, testing: false }));
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}><DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
    <DialogHeader className="border-b px-5 py-4 pr-14 sm:px-6">
      <DialogTitle>{provider ? "编辑 Provider" : "新建 Provider"}</DialogTitle>
      <DialogDescription>配置上游连接、模型发现和余额解析。Base URL 应包含 API 版本路径。</DialogDescription>
    </DialogHeader>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto bg-muted/20 p-4 sm:p-6">
      <EditorSection title="基础信息" description="定义 Provider 的连接方式和可用模型。">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称" hint="控制台内显示的名称，不影响上游请求。"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Internal OpenAI" /></Field>
          <Field label="接口类型" hint="选择上游遵循的 OpenAI 协议：Responses 走 /responses，Chat 走 /chat/completions。"><Select value={interfaceType} onValueChange={(value) => setInterfaceType(value as InterfaceType)}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="responses">Responses API</SelectItem><SelectItem value="chat">Chat Completions API</SelectItem></SelectContent></Select></Field>
          <Field label="Base URL" hint="上游 API 根地址，需包含版本前缀，例如 https://api.example.com/v1。模型与转发请求都会拼在这个地址后面。" wide><Input className="font-mono text-xs" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" /></Field>
          <Field label="描述" hint="可选备注，展示在 Provider 列表中。" wide><Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用途、地域或计费说明" /></Field>
          <div className="sm:col-span-2">
            <CodeEditor label="模型列表" description="每行一个模型 ID；留空时自动拉取上游 /models。" value={models} onChange={setModels} language="text" height="112px" placeholder={"gpt-5.6\nclaude-sonnet-4.5"} />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={modelsProbe.testing} onClick={() => void runModelsProbe()}>{modelsProbe.testing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}快速获取</Button>
              {modelsProbe.error ? <span className="text-xs text-destructive" role="alert">{modelsProbe.error}</span> : null}
            </div>
            {modelsProbe.result ? <div className="mt-3"><DebugResultView result={{ kind: "models", payload: modelsProbe.result }} onFillModels={(next) => { setModels(next.join("\n")); setModelsProbe({ testing: false, result: null, error: null }); }} /></div> : null}
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <OptionCard checked={enabled} onChange={setEnabled} title="启用 Provider" description="允许该 Provider 参与模型路由和账号调度。" />
          <OptionCard checked={balanceEnabled} onChange={setBalanceEnabled} title="配置余额查询" description="定期请求余额接口并按返回值控制调度。" />
        </div>
      </EditorSection>

      <EditorSection title="API Key 列表" description="每行一个上游 API Key；保存时自动创建对应账号，已保存的 Key 不会回显。">
        <CodeEditor label="API Key" description={provider ? `已保存 ${provider.keyCount ?? 0} 个 Key；留空保持不变，填写新 Key 会在保存时追加。` : "每行一个，保存 Provider 时一起创建。"} language="text" value={apiKeys} onChange={setApiKeys} height="112px" placeholder={"sk-one\nsk-two"} />
      </EditorSection>

      {balanceEnabled ? <>
        <EditorSection title="余额请求" description="使用模板变量 {{baseUrl}} 和 {{apiKey}} 构造请求。">
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <Field label="余额接口 URL" hint="余额查询地址，支持 {{baseUrl}} 与 {{apiKey}} 模板变量。DeepSeek 为 GET https://api.deepseek.com/user/balance（无 /v1 前缀，无 Body）。"><Input className="font-mono text-xs" value={balanceUrl} onChange={(event) => setBalanceUrl(event.target.value)} placeholder="{{baseUrl}}/user/balance" /></Field>
            <Field label="请求方法" hint="余额接口使用的 HTTP 方法。"><Select value={balanceMethod} onValueChange={(value) => setBalanceMethod(value as "GET" | "POST")}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="GET">GET</SelectItem><SelectItem value="POST">POST</SelectItem></SelectContent></Select></Field>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <CodeEditor label="Headers" description="字符串键值对，支持 {{baseUrl}} 与 {{apiKey}}。" language="json" value={balanceHeaders} onChange={setBalanceHeaders} height="176px" invalid={!isValidJson(balanceHeaders)} onFormat={() => setBalanceHeaders(formatJson(balanceHeaders))} />
            <CodeEditor label="Body" description={balanceMethod === "GET" ? "GET 请求不发送 Body，已禁用。" : "可选请求体；仅 POST 时发送，支持 JSON 与模板变量。"} language="json" value={balanceBody} onChange={setBalanceBody} height="176px" placeholder={'{"scope":"billing"}'} invalid={balanceMethod === "POST" && Boolean(balanceBody.trim()) && !isValidJson(balanceBody)} onFormat={balanceBody.trim() ? () => setBalanceBody(formatJson(balanceBody)) : undefined} disabled={balanceMethod === "GET"} />
          </div>
        </EditorSection>
        <EditorSection title="响应解析" description="函数接收上游响应 JSON，并返回标准余额结构。">
          <CodeEditor label="Extractor 函数" description="函数接收上游响应并返回 { remaining, total?, isValid?, type?, unit? }，详见页面底部协议说明。" language="javascript" value={extractor} onChange={setExtractor} height="280px" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={balanceProbe.testing} onClick={() => void runBalanceProbe()}>{balanceProbe.testing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}测试余额接口</Button>
            {balanceProbe.error ? <span className="text-xs text-destructive" role="alert">{balanceProbe.error}</span> : null}
          </div>
          {balanceProbe.result ? <div className="mt-3"><DebugResultView result={{ kind: "balance", payload: balanceProbe.result }} onFillModels={() => undefined} /></div> : null}
        </EditorSection>
      </> : null}
      {balanceEnabled ? <EditorSection title="余额查询示例" description="余额查询的 Extractor 写法；请按上游实际响应调整字段。">
        <div className="grid gap-4 lg:grid-cols-2">
          <ExampleBlock title="通用余额 Extractor" code={EXTRACTOR_EXAMPLE} />
          <ExampleBlock title="DeepSeek 余额 Extractor" code={DEEPSEEK_BALANCE_EXAMPLE} />
        </div>
      </EditorSection> : null}
      {error ? <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
    <DialogFooter className="m-0 shrink-0 rounded-none border-t bg-background px-5 py-4 sm:px-6"><Button variant="outline" onClick={onClose} disabled={saving}>取消</Button><Button onClick={() => void save()} disabled={saving}>{saving ? <LoaderCircle className="animate-spin" /> : null}保存 Provider</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function EditorSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="overflow-hidden rounded-xl border bg-background shadow-xs">
    <div className="border-b bg-muted/30 px-4 py-3 sm:px-5"><h3 className="text-sm font-medium">{title}</h3><p className="mt-0.5 text-xs text-muted-foreground">{description}</p></div>
    <div className="p-4 sm:p-5">{children}</div>
  </section>;
}

function OptionCard({ checked, onChange, title, description }: { checked: boolean; onChange: (value: boolean) => void; title: string; description: string }) {
  return <label className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${checked ? "border-foreground/20 bg-foreground/[0.03]" : "bg-background hover:bg-muted/30"}`}>
    <Checkbox className="mt-0.5" checked={checked} onCheckedChange={(value) => onChange(value === true)} />
    <span><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span></span>
  </label>;
}

function CodeEditor({ label, description, language, value, onChange, height, placeholder, invalid = false, onFormat, disabled = false }: { label: string; description?: string; language: "json" | "javascript" | "text"; value: string; onChange: (value: string) => void; height: string; placeholder?: string; invalid?: boolean; onFormat?: () => void; disabled?: boolean }) {
  const extensions = language === "json" ? JSON_EDITOR_EXTENSIONS : language === "javascript" ? JAVASCRIPT_EDITOR_EXTENSIONS : [];
  const languageLabel = language === "javascript" ? "JavaScript" : language === "json" ? "JSON" : "TEXT";
  return <div>
    <div className="mb-1.5 flex min-h-5 items-center gap-2">
      <Label>{label}</Label>
      {description ? <span className="text-[11px] text-muted-foreground">{description}</span> : null}
      <span className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[9px] tracking-wide ${invalid ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{invalid ? "INVALID JSON" : languageLabel}</span>
      {onFormat ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onFormat}>格式化</Button> : null}
    </div>
    <div className={`overflow-hidden rounded-lg border bg-[#fbfbfa] transition-shadow focus-within:ring-2 focus-within:ring-ring/30 ${invalid ? "border-destructive/50" : "border-input"} ${disabled ? "opacity-60" : ""}`}>
      <CodeMirror
        aria-label={label}
        value={value}
        height={height}
        extensions={extensions}
        editable={!disabled}
        onChange={onChange}
        placeholder={placeholder}
        theme="light"
        basicSetup={{ lineNumbers: true, foldGutter: language !== "text", highlightActiveLine: true, highlightActiveLineGutter: true, bracketMatching: true, closeBrackets: true, autocompletion: true }}
        className="text-[13px] [&_.cm-activeLine]:bg-black/[0.025] [&_.cm-activeLineGutter]:bg-black/[0.04] [&_.cm-content]:py-2 [&_.cm-editor]:bg-transparent [&_.cm-editor.cm-focused]:outline-none [&_.cm-gutters]:border-r [&_.cm-gutters]:border-border/70 [&_.cm-gutters]:bg-muted/30 [&_.cm-line]:px-2 [&_.cm-scroller]:font-mono"
      />
    </div>
  </div>;
}

function isValidJson(value: string): boolean {
  try { JSON.parse(value); return true; } catch { return false; }
}

function formatJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function KeyManager({ provider, onClose, adminFetch }: { provider: CustomProvider; onClose: () => void; adminFetch: (path: string, init?: RequestInit) => Promise<Response> }) {
  const confirm = useConfirm();
  const resource = useAdminResource<{ keys: ProviderKey[] }>(`/api/admin/custom-providers/${provider.id}/keys`);
  const [name, setName] = useState(""); const [apiKey, setApiKey] = useState(""); const [maxConcurrency, setMaxConcurrency] = useState("");
  const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState<ProviderKey | null>(null); const [replacementKey, setReplacementKey] = useState("");
  const [editing, setEditing] = useState<ProviderKey | null>(null); const [editName, setEditName] = useState(""); const [editConcurrency, setEditConcurrency] = useState("");
  const keys = resource.data?.keys ?? [];
  async function create() {
    setSaving(true); setError(null);
    try {
      const response = await adminFetch(`/api/admin/custom-providers/${provider.id}/keys`, { method: "POST", body: JSON.stringify({ name: name.trim() || undefined, apiKey, maxConcurrency: maxConcurrency ? Number(maxConcurrency) : undefined }) });
      const payload = await response.json().catch(() => null); if (!response.ok) throw new Error(errorMessage(payload, "添加失败"));
      const warnings = payload && typeof payload === "object" && Array.isArray((payload as { warnings?: unknown }).warnings) ? (payload as { warnings: string[] }).warnings : [];
      setNotice(warnings.length ? `Key 已保存；上游探测提示：${warnings.join("；")}` : "API Key 已添加并完成上游探测");
      setName(""); setApiKey(""); setMaxConcurrency(""); await resource.refresh();
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
    const approved = await confirm({ title: `删除 API Key“${key.name}”？`, description: "该 Key 会立即退出调度，此操作不可恢复。", confirmText: "永久删除", destructive: true });
    if (!approved) return;
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
  function openEdit(key: ProviderKey) {
    setEditing(key); setEditName(key.name); setEditConcurrency(key.maxConcurrency > 0 ? String(key.maxConcurrency) : ""); setError(null);
  }
  async function saveSettings() {
    if (!editing || !editName.trim()) return;
    setSaving(true); setError(null);
    try {
      await patch(editing, { name: editName.trim(), maxConcurrency: editConcurrency ? Number(editConcurrency) : null });
      setEditing(null); setEditName(""); setEditConcurrency("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSaving(false); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
    <DialogHeader><DialogTitle>{provider.name} · API Keys</DialogTitle><DialogDescription>名称留空时自动编号，并发留空表示不限制。密钥写入后不再回显。</DialogDescription></DialogHeader>
    <div className="grid gap-3 rounded-md border bg-[#fafafa] p-3 sm:grid-cols-[1fr_1.4fr_100px_auto]">
      <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="名称（自动编号）" aria-label="Key 名称，可选" />
      <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="API Key" aria-label="API Key" />
      <Input type="number" min={1} step={1} value={maxConcurrency} onChange={(event) => setMaxConcurrency(event.target.value)} placeholder="不限并发" aria-label="并发上限，可选" />
      <Button onClick={() => void create()} disabled={saving || !apiKey.trim()}>{saving ? <LoaderCircle className="animate-spin" /> : <Plus />}添加</Button>
    </div>
    {error ? <p className="text-xs text-destructive">{error}</p> : null}
    {notice ? <p className="text-xs text-muted-foreground" role="status">{notice}</p> : null}
    {resource.loading ? <LoadingTable rows={3} columns={4} /> : keys.length ? <div className="divide-y rounded-md border">
      {keys.map((key) => <div key={key.id} className="grid gap-2 px-3 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center">
        <div><p className="text-sm font-medium">{key.name}</p><p className="mt-1 text-[11px] text-muted-foreground">{key.maxConcurrency > 0 ? `并发 ${key.maxConcurrency}` : "并发不限制"} · 最近成功 {formatDate(key.lastSuccessAt)} · {key.authState}</p></div>
        <div className="flex gap-1"><Button variant="outline" size="sm" onClick={() => void patch(key, { enabled: key.adminState !== "ENABLED" })}>{key.adminState === "ENABLED" ? "停用" : "启用"}</Button><Button variant="outline" size="sm" onClick={() => openEdit(key)}><Pencil />编辑</Button><Button variant="outline" size="sm" onClick={() => { setRotating(key); setReplacementKey(""); }}><RefreshCw />更换</Button></div>
        <Button variant="outline" size="icon-sm" className="text-destructive" onClick={() => void remove(key)}><Trash2 /></Button>
      </div>)}
    </div> : <p className="py-8 text-center text-sm text-muted-foreground">尚未添加 API Key</p>}
    {rotating ? <div className="flex flex-wrap items-center gap-2 rounded-md border bg-[#fafafa] p-3"><span className="text-xs">更换 {rotating.name}</span><Input type="password" className="min-w-56 flex-1" value={replacementKey} onChange={(event) => setReplacementKey(event.target.value)} placeholder="新的 API Key" /><Button variant="outline" size="sm" onClick={() => setRotating(null)}>取消</Button><Button size="sm" disabled={saving || !replacementKey.trim()} onClick={() => void replaceKey()}>保存新密钥</Button></div> : null}
    {editing ? <div className="grid gap-2 rounded-md border bg-[#fafafa] p-3 sm:grid-cols-[1fr_150px_auto_auto]"><Input value={editName} onChange={(event) => setEditName(event.target.value)} placeholder="名称" aria-label="Key 名称" /><Input type="number" min={1} step={1} value={editConcurrency} onChange={(event) => setEditConcurrency(event.target.value)} placeholder="不限并发" aria-label="并发上限，可选" /><Button variant="outline" size="sm" onClick={() => setEditing(null)} disabled={saving}>取消</Button><Button size="sm" disabled={saving || !editName.trim()} onClick={() => void saveSettings()}>{saving ? <LoaderCircle className="animate-spin" /> : null}保存</Button></div> : null}
  </DialogContent></Dialog>;
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: React.ReactNode }) {
  const [hintOpen, setHintOpen] = useState(false);
  return <div className={wide ? "sm:col-span-2" : ""}>
    <div className="mb-1.5 flex items-center gap-1"><Label className="mb-0">{label}</Label>{hint ? <button type="button" onClick={() => setHintOpen((open) => !open)} className="grid size-4 place-items-center rounded-full border text-muted-foreground hover:text-foreground" aria-label={`${label} 说明`} aria-expanded={hintOpen}><Info className="size-2.5" /></button> : null}</div>
    {hintOpen && hint ? <p className="mb-1.5 text-[11px] leading-5 text-muted-foreground">{hint}</p> : null}
    {children}
  </div>;
}

type DebugProbePayload = {
  ok?: unknown
  durationMs?: unknown
  models?: { ok?: unknown; status?: unknown; durationMs?: unknown; models?: unknown; error?: unknown } | null
  balance?: { ok?: unknown; status?: unknown; durationMs?: unknown; valid?: unknown; windows?: unknown; error?: unknown } | null
};

function DebugResultView({ result, onFillModels }: { result: { kind: "models" | "balance"; payload: unknown }; onFillModels: (models: string[]) => void }) {
  const payload = result.payload && typeof result.payload === "object" ? result.payload as DebugProbePayload : null;
  const ok = payload?.ok === true;
  const durationMs = typeof payload?.durationMs === "number" ? payload.durationMs : null;
  return <div className="mt-3 space-y-3 rounded-lg border bg-background p-3">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-sm px-1.5 py-0.5 text-[10px] ${ok ? "bg-success-soft text-success" : "bg-destructive/10 text-destructive"}`}>{ok ? "成功" : "失败"}</span>
      {durationMs !== null ? <span className="font-mono text-[11px] text-muted-foreground">{durationMs} ms</span> : null}
    </div>
    {result.kind === "models" ? <ModelsDebugResult models={payload?.models} onFillModels={onFillModels} /> : <BalanceDebugResult balance={payload?.balance} />}
  </div>;
}

function ModelsDebugResult({ models, onFillModels }: { models: DebugProbePayload["models"]; onFillModels: (models: string[]) => void }) {
  const ok = models?.ok === true;
  const status = typeof models?.status === "number" ? models.status : null;
  const durationMs = typeof models?.durationMs === "number" ? models.durationMs : null;
  const modelList = Array.isArray(models?.models) ? models.models.filter((value): value is string => typeof value === "string") : [];
  const error = typeof models?.error === "string" ? models.error : null;
  if (!models) return <p className="text-xs text-muted-foreground">没有返回 /models 结果。</p>;
  return <div className="space-y-3 text-xs">
    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
      {status !== null ? <span className="font-mono">HTTP {status}</span> : null}
      {durationMs !== null ? <span className="font-mono">{durationMs} ms</span> : null}
      {ok ? <span>共 {modelList.length} 个模型</span> : null}
    </div>
    {ok ? <>
      <div className="flex flex-wrap gap-1.5">{modelList.map((model) => <code key={model} className="rounded-md border bg-[#fbfbfa] px-1.5 py-0.5 font-mono text-[10px]">{model}</code>)}</div>
      <Button type="button" variant="outline" size="sm" onClick={() => onFillModels(modelList)}>填入模型列表</Button>
    </> : error ? <p className="text-destructive">{error}</p> : <p className="text-muted-foreground">未返回错误信息。</p>}
  </div>;
}

function BalanceDebugResult({ balance }: { balance: DebugProbePayload["balance"] }) {
  const ok = balance?.ok === true;
  const valid = balance?.valid === true;
  const status = typeof balance?.status === "number" ? balance.status : null;
  const durationMs = typeof balance?.durationMs === "number" ? balance.durationMs : null;
  const error = typeof balance?.error === "string" ? balance.error : null;
  const windows = Array.isArray(balance?.windows) ? balance.windows as Array<{ kind?: unknown; remaining?: unknown; total?: unknown; unit?: unknown }> : [];
  if (!balance) return <p className="text-xs text-muted-foreground">没有返回余额结果。</p>;
  return <div className="space-y-3 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <span className={`rounded-sm px-1.5 py-0.5 text-[10px] ${valid ? "bg-success-soft text-success" : "bg-destructive/10 text-destructive"}`}>{valid ? "额度有效" : "额度无效"}</span>
      {status !== null ? <span className="font-mono text-muted-foreground">HTTP {status}</span> : null}
      {durationMs !== null ? <span className="font-mono text-muted-foreground">{durationMs} ms</span> : null}
    </div>
    {windows.length ? <>
      <div className="grid grid-cols-[90px_1fr_1fr_70px] gap-2 px-2 text-[10px] text-muted-foreground"><span>类型</span><span>剩余</span><span>总量</span><span>单位</span></div>
      <div className="grid gap-2 sm:grid-cols-2">{windows.map((window, index) => (
        <div key={index} className="grid grid-cols-[90px_1fr_1fr_70px] gap-2 rounded-md border bg-[#fbfbfa] px-2 py-1.5 font-mono text-[11px]">
          <code>{typeof window.kind === "string" ? window.kind : "-"}</code>
          <span>{typeof window.remaining === "number" ? window.remaining : "-"}</span>
          <span>{typeof window.total === "number" ? window.total : "∞"}</span>
          <span>{typeof window.unit === "string" ? window.unit : "-"}</span>
        </div>
      ))}</div>
    </> : ok ? <p className="text-muted-foreground">没有窗口数据。</p> : null}
    {error ? <p className="text-destructive">{error}</p> : null}
  </div>;
}

function ExampleBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const ok = await copyToClipboard(code);
    if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
  }
  return <div>
    <div className="mb-1.5 flex items-center gap-2">
      <p className="text-xs font-medium">{title}</p>
      <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => void copy()} aria-label={`复制 ${title} 示例`}>{copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}{copied ? "已复制" : "复制"}</Button>
    </div>
    <pre className="overflow-x-auto rounded-md border bg-[#fbfbfa] p-3 font-mono text-[11px] leading-5">{code}</pre>
  </div>;
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
