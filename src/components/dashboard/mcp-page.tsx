"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Info,
  LoaderCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAdmin } from "./admin-context";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel } from "./page-kit";
import { useAdminResource } from "./use-admin-resource";
import { copyToClipboard } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm-provider";

interface MCPToolConfig {
  poolType?: string;
  model?: string;
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  ownerUserId?: string;
}
interface MCPTool {
  toolType: string;
  name: string;
  description?: string;
  enabled?: boolean;
  config?: MCPToolConfig;
}
interface MCPServer {
  endpoint?: string;
  protocolVersion?: string;
  toolCount?: number;
  tokenConfigured?: boolean;
  token?: string;
}
interface MCPPayload {
  server?: MCPServer;
  tools?: MCPTool[];
}
interface ModelCatalog {
  poolType: string;
  label: string;
  models: string[];
}
interface MCPUser {
  id: string;
  username: string;
  displayName?: string;
}

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as { error?: { message?: unknown }; message?: unknown };
  if (typeof value.error?.message === "string") return value.error.message;
  return typeof value.message === "string" ? value.message : fallback;
}

const DEFAULT_PROMPT = "请用中文描述这张图片，包括主体、场景、文字和明显细节。";
const MCP_JSON_EXAMPLE = `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "describe_image",
    "arguments": {
      "image": "https://example.com/photo.png",
      "prompt": "请描述这张图片的内容"
    }
  }
}`;

export function McpPage() {
  const { adminFetch } = useAdmin();
  const confirm = useConfirm();
  const resource = useAdminResource<MCPPayload>("/api/admin/mcp");
  const server = resource.data?.server ?? null;
  const tools = resource.data?.tools ?? [];

  const [origin, setOrigin] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setOrigin(window.location.origin), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const endpoint = useMemo(
    () => server?.endpoint || (origin ? `${origin}/mcp` : "/mcp"),
    [origin, server?.endpoint]
  );

  const tokenConfigured = server?.tokenConfigured === true || Boolean(server?.token);
  const token = server?.token || "";
  const [revealToken, setRevealToken] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [resettingToken, setResettingToken] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [newTokenCopied, setNewTokenCopied] = useState(false);

  const [message, setMessage] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  // 编辑对话框状态
  const [editing, setEditing] = useState<MCPTool | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [temperature, setTemperature] = useState("0.3");
  const [catalogs, setCatalogs] = useState<ModelCatalog[]>([]);
  const [mcpUsers, setMcpUsers] = useState<MCPUser[]>([]);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  // 测试对话框状态
  const [testing, setTesting] = useState<MCPTool | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [testPrompt, setTestPrompt] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ text?: string; model?: string } | null>(null);

  const effectiveOwnerUserId = ownerUserId || mcpUsers[0]?.id || "";

  const selectedCatalog = catalogs.find((catalog) => catalog.poolType === provider) ?? null;
  const modelOptions = selectedCatalog?.models ?? [];

  async function loadMeta() {
    setMetaLoading(true);
    setMetaError(null);
    try {
      const [modelsResponse, usersResponse] = await Promise.all([
        adminFetch("/api/admin/mcp/models"),
        adminFetch("/api/admin/mcp/users"),
      ]);
      const modelsPayload = await modelsResponse.json().catch(() => null) as { catalogs?: ModelCatalog[] } | null;
      const usersPayload = await usersResponse.json().catch(() => null) as { users?: MCPUser[] } | null;
      if (!modelsResponse.ok) throw new Error(errorMessage(modelsPayload, "拉取识图模型失败"));
      if (!usersResponse.ok) throw new Error(errorMessage(usersPayload, "拉取账号列表失败"));
      setCatalogs(modelsPayload?.catalogs ?? []);
      setMcpUsers(usersPayload?.users ?? []);
    } catch (cause) {
      setMetaError(cause instanceof Error ? cause.message : "拉取配置选项失败");
    } finally {
      setMetaLoading(false);
    }
  }

  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => void loadMeta(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function openEdit(tool: MCPTool) {
    const config = tool.config ?? {};
    setEditing(tool);
    setProvider(config.poolType ?? "");
    setModelInput(config.model ?? "");
    setOwnerUserId(config.ownerUserId ?? "");
    setPrompt(config.prompt ?? "");
    setMaxTokens(config.maxTokens != null ? String(config.maxTokens) : "1024");
    setTemperature(config.temperature != null ? String(config.temperature) : "0.3");
    setFormError(null);
  }

  async function toggleTool(tool: MCPTool) {
    const next = !(tool.enabled === true);
    setToggling(tool.toolType);
    setMessage(null);
    try {
      const response = await adminFetch(`/api/admin/mcp/tools/${encodeURIComponent(tool.toolType)}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: next }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "更新工具状态失败"));
      setMessage(`已${next ? "启用" : "停用"} ${tool.name}`);
      await resource.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "更新工具状态失败");
    } finally {
      setToggling(null);
    }
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const model = modelInput.trim();
    if (!model) {
      setFormError("请填写识图模型（可从下拉选择或直接输入模型名）");
      return;
    }
    const maxTokensValue = Math.min(32768, Math.max(1, Math.round(Number(maxTokens) || 1024)));
    const temperatureValue = Math.min(2, Math.max(0, Number(temperature) || 0.3));
    setSaving(true);
    setFormError(null);
    try {
      const response = await adminFetch(`/api/admin/mcp/tools/${encodeURIComponent(editing.toolType)}`, {
        method: "PUT",
        body: JSON.stringify({
          config: {
            poolType: provider || '',
            model,
            ownerUserId: effectiveOwnerUserId || undefined,
            prompt: prompt || undefined,
            maxTokens: maxTokensValue,
            temperature: temperatureValue,
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "保存识图配置失败"));
      setMessage(`已保存 ${editing.name} 的识图配置`);
      setEditing(null);
      await resource.refresh();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "保存识图配置失败");
    } finally {
      setSaving(false);
    }
  }

  function openTest(tool: MCPTool) {
    setTesting(tool);
    setImageUrl("");
    setImageDataUrl(null);
    setTestPrompt("");
    setTestError(null);
    setTestResult(null);
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImageDataUrl(typeof reader.result === "string" ? reader.result : null);
      setTestError(null);
    };
    reader.onerror = () => setTestError("图片读取失败，请重新选择");
    reader.readAsDataURL(file);
  }

  async function runTest(event: FormEvent) {
    event.preventDefault();
    if (!testing) return;
    const image = imageUrl.trim() || imageDataUrl || "";
    if (!image) {
      setTestError("请填写图片 URL 或上传本地图片");
      return;
    }
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);
    try {
      const body: Record<string, string> = { image };
      if (testPrompt.trim()) body.prompt = testPrompt.trim();
      const response = await adminFetch("/api/admin/mcp/tools/describe_image/test", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { result?: { text?: string; model?: string } } | null;
      if (!response.ok) throw new Error(errorMessage(payload, "识图测试失败"));
      setTestResult(payload?.result ?? null);
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : "识图测试失败");
    } finally {
      setTestLoading(false);
    }
  }

  async function copyToken() {
    setCopiedToken(false);
    if (!token) {
      setMessage("当前接口未返回令牌内容，可点击「重置令牌」获取新令牌后再复制。");
      return;
    }
    const ok = await copyToClipboard(token);
    if (ok) setCopiedToken(true);
    else setMessage("复制失败，请手动选择并复制。");
  }

  async function resetToken() {
    const approved = await confirm({
      title: "重置 MCP 访问令牌？",
      description: "重置后旧令牌立即失效，所有 MCP 客户端需要更新 Authorization 头。",
      confirmText: "确认重置",
      destructive: true,
    });
    if (!approved) return;
    setResettingToken(true);
    setMessage(null);
    try {
      const response = await adminFetch("/api/admin/mcp", { method: "POST", body: JSON.stringify({ resetToken: true }) });
      const payload = await response.json().catch(() => null) as { token?: string; accessToken?: string; server?: { token?: string } } | null;
      if (!response.ok) throw new Error(errorMessage(payload, "重置令牌失败"));
      const next = payload?.token || payload?.accessToken || payload?.server?.token || null;
      setNewToken(next);
      setNewTokenCopied(false);
      setMessage(next ? "访问令牌已重置" : "访问令牌已重置，但响应中未包含新令牌内容");
      await resource.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "重置令牌失败");
    } finally {
      setResettingToken(false);
    }
  }

  async function copyNewToken() {
    if (!newToken) return;
    const ok = await copyToClipboard(newToken);
    if (ok) setNewTokenCopied(true);
    else setMessage("复制失败，请长按上方令牌手动复制");
  }

  const tokenText = revealToken && token ? token : "••••••••••••";

  return (
    <>
      <PageIntro
        eyebrow="MCP TOOLS"
        title="MCP 工具"
        description="通过 MCP 协议向外部客户端提供识图等工具能力。"
        actions={
          <Button variant="outline" size="sm" onClick={() => void resource.refresh()}>
            <RefreshCw data-icon="inline-start" />
            重新载入
          </Button>
        }
      />
      {message ? (
        <p className="mb-4 rounded-md border bg-white px-3 py-2 text-xs text-muted-foreground" role="status">{message}</p>
      ) : null}
      {resource.error ? (
        <Panel>
          <ErrorState message={resource.error} onRetry={() => void resource.refresh()} />
        </Panel>
      ) : (
        <div className="space-y-4">
          <Panel title="MCP 服务信息" description="MCP 客户端连接地址与访问令牌配置。">
            <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-4">
              <InfoCell label="服务端点" mono>{endpoint}</InfoCell>
              <InfoCell label="协议版本" mono>{server?.protocolVersion || "—"}</InfoCell>
              <InfoCell label="工具数量">{server?.toolCount ?? tools.length}</InfoCell>
              <div className="min-w-0 rounded-lg border bg-[#fafafa] p-3">
                <p className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">访问令牌</p>
                <div className="mt-1.5 flex items-center gap-2">
                  {tokenConfigured ? (
                    <code className="min-w-0 flex-1 truncate font-mono text-sm tracking-widest" title={revealToken ? token : undefined}>{tokenText}</code>
                  ) : (
                    <span className="text-sm font-medium text-warning">未配置</span>
                  )}
                </div>
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {tokenConfigured ? (
                    <>
                      <Button size="xs" variant="outline" onClick={() => setRevealToken((value) => !value)}>
                        {revealToken ? <EyeOff /> : <Eye />}
                        {revealToken ? "隐藏" : "显示"}
                      </Button>
                      <Button size="xs" variant="outline" onClick={() => void copyToken()}>
                        {copiedToken ? <Check /> : <Copy />}
                        {copiedToken ? "已复制" : "复制"}
                      </Button>
                    </>
                  ) : null}
                  <Button size="xs" variant="outline" disabled={resettingToken} onClick={() => void resetToken()}>
                    {resettingToken ? <LoaderCircle className="animate-spin" /> : <RotateCcw />}
                    重置令牌
                  </Button>
                </div>
              </div>
            </div>
            <Collapsible className="border-t px-4 py-2.5 sm:px-5">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="-ml-2 h-7 text-xs text-muted-foreground">
                  <Info data-icon="inline-start" />
                  连接说明
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-3 grid gap-4 pb-3 lg:grid-cols-2">
                  <div className="space-y-2.5 text-xs leading-6 text-muted-foreground">
                    <p className="font-medium text-foreground">MCP 客户端连接</p>
                    <p><span>连接地址：</span><code className="rounded-md border bg-white px-1.5 py-0.5 font-mono text-[11px] text-foreground">{endpoint}</code></p>
                    <p><span>鉴权方式：</span><code className="rounded-md border bg-white px-1.5 py-0.5 font-mono text-[11px] text-foreground">Authorization: Bearer &lt;访问令牌&gt;</code></p>
                    <p>在支持 MCP 的客户端（如 Claude Desktop、Cursor）中配置以上连接地址与鉴权头，即可调用本服务暴露的工具。</p>
                  </div>
                  <div className="min-w-0">
                    <p className="mb-2 text-xs font-medium text-foreground">describe_image 调用示例（JSON-RPC）</p>
                    <pre className="overflow-x-auto rounded-lg border bg-white p-3 font-mono text-[11px] leading-5">{MCP_JSON_EXAMPLE}</pre>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </Panel>

          <Panel title="工具列表" description={`${tools.length} 个工具；停用后外部客户端无法调用。`}>
            {resource.loading ? (
              <LoadingTable rows={3} columns={6} />
            ) : tools.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4">名称</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>描述</TableHead>
                    <TableHead>识图模型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="px-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tools.map((tool) => (
                    <TableRow key={tool.toolType}>
                      <TableCell className="px-4 font-medium">{tool.name}</TableCell>
                      <TableCell><Badge variant="outline" className="font-mono text-[11px]">{tool.toolType}</Badge></TableCell>
                      <TableCell className="max-w-72 whitespace-normal text-xs text-muted-foreground">{tool.description || "—"}</TableCell>
                      <TableCell>
                        {tool.config?.model ? (
                          <span className="font-mono text-xs">{tool.config.model}</span>
                        ) : (
                          <Badge variant="outline" className="border-warning/20 bg-warning-soft text-warning">未配置</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          aria-pressed={tool.enabled === true}
                          disabled={toggling === tool.toolType}
                          onClick={() => void toggleTool(tool)}
                          className={`inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors disabled:opacity-50 ${tool.enabled === true ? "border-success/20 bg-success-soft text-success" : "border-border bg-muted/40 text-muted-foreground hover:bg-muted"}`}
                        >
                          {toggling === tool.toolType ? (
                            <LoaderCircle className="size-3 animate-spin" />
                          ) : (
                            <span className="size-1.5 rounded-full bg-current" />
                          )}
                          {tool.enabled === true ? "已启用" : "已停用"}
                        </button>
                      </TableCell>
                      <TableCell className="px-4 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => openEdit(tool)}>
                            <Pencil data-icon="inline-start" />
                            编辑
                          </Button>
                          {tool.toolType === "describe_image" ? (
                            <Button variant="outline" size="sm" onClick={() => openTest(tool)}>
                              <Sparkles data-icon="inline-start" />
                              测试
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState title="暂无工具" description="MCP 服务尚未注册任何工具，请稍后刷新重试。" />
            )}
          </Panel>
        </div>
      )}

      {/* 编辑识图配置 */}
      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open && !saving) setEditing(null); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑识图配置</DialogTitle>
            <DialogDescription>{editing ? `${editing.name}（${editing.toolType}）` : ""} — 配置识图使用的模型、账号归属与推理参数。</DialogDescription>
          </DialogHeader>
          <form id="mcp-edit-form" onSubmit={(event) => void saveConfig(event)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mcp-provider">识图 Provider</Label>
              <Select value={provider || "auto"} onValueChange={(value) => { setProvider(value === "auto" ? "" : value); setModelInput(""); }}>
                <SelectTrigger id="mcp-provider" className="w-full bg-white"><SelectValue placeholder="选择识图 Provider" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">自动路由</SelectItem>
                  {catalogs.map((catalog) => (
                    <SelectItem key={catalog.poolType} value={catalog.poolType}>{catalog.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-5 text-muted-foreground">留空表示自动路由；选择 Provider 后，下方模型下拉会更新为该 Provider 的模型列表。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-model">识图模型</Label>
              <Select value={modelOptions.includes(modelInput) ? modelInput : undefined} onValueChange={setModelInput}>
                <SelectTrigger id="mcp-model" className="w-full bg-white"><SelectValue placeholder={provider ? "选择模型或手动输入模型名" : "自动路由下请直接输入模型名"} /></SelectTrigger>
                <SelectContent>
                  {modelOptions.map((model) => (
                    <SelectItem key={model} value={model}>{model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input value={modelInput} onChange={(event) => setModelInput(event.target.value)} placeholder="例如 gpt-5.6 / gemini-2.5-pro" className="font-mono text-xs" aria-label="自定义模型名" />
              <p className="text-[11px] leading-5 text-muted-foreground">从下拉选择会自动填入输入框，也可以直接输入自定义模型名（必填）。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-owner">账号归属</Label>
              <Select value={effectiveOwnerUserId} onValueChange={setOwnerUserId}>
                <SelectTrigger id="mcp-owner" className="w-full bg-white"><SelectValue placeholder={metaLoading ? "正在加载账号…" : "选择使用哪个用户的账号池"} /></SelectTrigger>
                <SelectContent>
                  {mcpUsers.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.displayName || user.username}{user.displayName && user.displayName !== user.username ? `（${user.username}）` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-prompt">提示词</Label>
              <Textarea id="mcp-prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={DEFAULT_PROMPT} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="mcp-max-tokens">最大输出 Token</Label>
                <Input id="mcp-max-tokens" type="number" min={1} max={32768} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mcp-temperature">温度</Label>
                <Input id="mcp-temperature" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(event.target.value)} />
              </div>
            </div>
            {metaLoading ? <p className="text-xs text-muted-foreground">正在加载 Provider 与账号选项…</p> : null}
            {metaError ? <p className="text-sm text-destructive" role="alert">{metaError}</p> : null}
            {formError ? <p className="text-sm text-destructive" role="alert">{formError}</p> : null}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>取消</Button>
            <Button type="submit" form="mcp-edit-form" disabled={saving}>
              {saving ? <LoaderCircle className="animate-spin" /> : null}
              {saving ? "保存中" : "保存配置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 测试识图 */}
      <Dialog open={Boolean(testing)} onOpenChange={(open) => { if (!open && !testLoading) setTesting(null); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>测试识图</DialogTitle>
            <DialogDescription>{testing ? `${testing.name}（${testing.toolType}）` : ""} — 提交一张图片，验证模型识别效果。</DialogDescription>
          </DialogHeader>
          <form id="mcp-test-form" onSubmit={(event) => void runTest(event)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mcp-test-url">图片 URL</Label>
              <Input id="mcp-test-url" className="font-mono text-xs" value={imageUrl} onChange={(event) => setImageUrl(event.target.value)} placeholder="https://example.com/photo.png" />
              <p className="text-[11px] leading-5 text-muted-foreground">填写公开可访问的图片地址，或直接上传本地图片（二选一）。</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-test-file">上传本地图片</Label>
              <Input id="mcp-test-file" type="file" accept="image/*" onChange={onFileChange} className="h-auto py-1.5" />
              {imageDataUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageDataUrl} alt="图片预览" className="max-h-64 w-full rounded-md border object-contain" />
                </>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-test-prompt">提示词（可选）</Label>
              <Textarea id="mcp-test-prompt" rows={2} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} placeholder="留空使用工具默认提示词" />
            </div>
            {testError ? <p className="text-sm text-destructive" role="alert">{testError}</p> : null}
            {testResult ? (
              <div className="space-y-2 rounded-lg border bg-[#fbfbfa] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-sm bg-success-soft px-1.5 py-0.5 text-[10px] text-success">识别完成</span>
                  {testResult.model ? <Badge variant="outline" className="font-mono text-[11px]">{testResult.model}</Badge> : null}
                </div>
                <pre className="max-h-72 overflow-y-auto text-xs leading-6 whitespace-pre-wrap break-words">{testResult.text || "（没有返回文本）"}</pre>
              </div>
            ) : null}
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTesting(null)} disabled={testLoading}>关闭</Button>
            <Button type="submit" form="mcp-test-form" disabled={testLoading}>
              {testLoading ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
              {testLoading ? "识别中" : "运行识图"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重置后的新令牌 */}
      <Dialog open={Boolean(newToken)} onOpenChange={(open) => { if (!open) setNewToken(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新的 MCP 访问令牌</DialogTitle>
            <DialogDescription>请立即复制并更新到 MCP 客户端配置中；关闭后无法再次查看。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="select-all break-all rounded-md border bg-[#fafafa] p-3 font-mono text-xs leading-5">{newToken}</div>
            <Button variant="outline" className="w-full" onClick={() => void copyNewToken()}>
              {newTokenCopied ? <Check /> : <Copy />}
              {newTokenCopied ? "已复制" : "复制令牌"}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setNewToken(null)}>我已保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function InfoCell({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-[#fafafa] p-3">
      <p className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={`mt-1.5 truncate text-sm font-medium ${mono ? "font-mono text-xs" : ""}`}>{children}</p>
    </div>
  );
}