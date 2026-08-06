"use client";

import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Check,
  Copy,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAdmin } from "./admin-context";
import { copyToClipboard } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel } from "./page-kit";
import { useAdminResource } from "./use-admin-resource";

interface MCPToolConfig {
  poolType?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEnabled?: boolean;
  reasoningEffort?: "low" | "medium" | "high" | null;
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
}
interface MCPPayload {
  server?: MCPServer;
  tools?: MCPTool[];
}
interface ModelCatalog {
  poolType: string;
  label: string;
  models: string[];
  visionModels?: string[];
}

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const value = payload as { error?: { message?: unknown }; message?: unknown };
  if (typeof value.error?.message === "string") return value.error.message;
  return typeof value.message === "string" ? value.message : fallback;
}

const MCP_SERVER_NAME = "fusionrouter-mcp";
// 已通过线上实测确认支持图片输入的多模态模型（其余模型如 grok-4.5 / gpt-5.6-luna
// 端点不可用或不支持图片，选了会识图失败）。优先用后端 visionModels，这里作为兜底。
const RECOMMENDED_VISION_MODELS = ["minimax-m3", "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-plus", "qwen3.8-max", "mimo-v2.5"];

export function McpPage() {
  const { adminFetch } = useAdmin();
  const resource = useAdminResource<MCPPayload>("/api/admin/mcp");
  const server = resource.data?.server ?? null;
  const tools = resource.data?.tools ?? [];

  const [origin, setOrigin] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setOrigin(window.location.origin), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const endpoint = useMemo(
    () => (origin ? `${origin}/mcp` : server?.endpoint || "/mcp"),
    [origin, server?.endpoint]
  );

  const mcpServerConfig = useMemo(() => {
    if (!endpoint) return "";
    return JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: "cmd",
            args: [
              "/c",
              "npx",
              "-y",
              "fusionrouter-mcp",
              "--base-url",
              endpoint.replace(/\/mcp$/, ""),
              "--api-key",
              "<你的 API Key>",
            ],
          },
        },
      },
      null,
      2,
    );
  }, [endpoint]);
  const [configCopied, setConfigCopied] = useState(false);

  async function copyServerConfig() {
    if (!mcpServerConfig) return;
    const ok = await copyToClipboard(mcpServerConfig);
    if (ok) {
      setConfigCopied(true);
      window.setTimeout(() => setConfigCopied(false), 2000);
    } else {
      setMessage("复制失败，请手动选择并复制。");
    }
  }

  const [message, setMessage] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);


  // 编辑对话框状态
  const [editing, setEditing] = useState<MCPTool | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [provider, setProvider] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [prompt, setPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [temperature, setTemperature] = useState("0.3");
  const [reasoningEnabled, setReasoningEnabled] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<string>("");
  const [catalogs, setCatalogs] = useState<ModelCatalog[]>([]);
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  // 测试对话框状态：识图支持多图（URL / data URI 混合），可粘贴、可上传；搜索工具输入文本
  const [testing, setTesting] = useState<MCPTool | null>(null);
  const [testImages, setTestImages] = useState<string[]>([]);
  const [testUrlInput, setTestUrlInput] = useState("");
  const [testPrompt, setTestPrompt] = useState("");
  const [testContent, setTestContent] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ text?: string; model?: string } | null>(null);

  const selectedCatalog = catalogs.find((catalog) => catalog.poolType === provider) ?? null;
  const isSearchEditing = editing?.toolType === "deepseek_web_search";
  const isSearchTesting = testing?.toolType === "deepseek_web_search";
  const modelOptions = useMemo(() => {
    if (!editing) return [];
    if (editing.toolType === "deepseek_web_search") {
      // 搜索工具不做多模态过滤：是否支持 web search 由用户配置 Provider 后自行测试
      return selectedCatalog?.models ?? [];
    }
    // 识图只展示支持图片输入（多模态）的模型，避免误选 grok-4.5 / gpt-5.6-luna 等
    const vision = selectedCatalog?.visionModels?.length
      ? selectedCatalog.visionModels
      : RECOMMENDED_VISION_MODELS.filter((model) => (selectedCatalog?.models ?? []).includes(model));
    return [...vision];
  }, [editing, selectedCatalog]);

  async function loadMeta() {
    setMetaLoading(true);
    setMetaError(null);
    try {
      const modelsResponse = await adminFetch("/api/admin/mcp/models");
      const modelsPayload = await modelsResponse.json().catch(() => null) as { catalogs?: ModelCatalog[] } | null;
      if (!modelsResponse.ok) throw new Error(errorMessage(modelsPayload, "拉取识图模型失败"));
      setCatalogs(modelsPayload?.catalogs ?? []);
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
    setProvider(tool.toolType === "deepseek_web_search" ? (config.provider ?? "") : (config.poolType ?? ""));
    setModelInput(config.model ?? "");
    setPrompt(config.prompt ?? "");
    setMaxTokens(config.maxTokens != null ? String(config.maxTokens) : "1024");
    setTemperature(config.temperature != null ? String(config.temperature) : "0.3");
    setReasoningEnabled(config.reasoningEnabled === true);
    setReasoningEffort(config.reasoningEffort ?? "");
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
    const isSearch = editing.toolType === "deepseek_web_search";
    const model = modelInput.trim();
    if (!model) {
      setFormError(isSearch ? "请填写模型（可从下拉选择或直接输入模型名）" : "请填写识图模型（可从下拉选择或直接输入模型名）");
      return;
    }
    if (isSearch && !provider) {
      setFormError("请选择 Provider（不按模型自动路由，需明确指定）");
      return;
    }
    const maxTokensValue = Math.min(32768, Math.max(1, Math.round(Number(maxTokens) || 1024)));
    const temperatureValue = Math.min(2, Math.max(0, Number(temperature) || 0.3));
    setSaving(true);
    setFormError(null);
    try {
      const config = isSearch
        ? { provider: provider || null, model, maxTokens: maxTokensValue, temperature: temperatureValue }
        : {
            poolType: provider || '',
            model,
            prompt: prompt || undefined,
            maxTokens: maxTokensValue,
            temperature: temperatureValue,
            reasoningEnabled,
            reasoningEffort: reasoningEnabled && reasoningEffort ? reasoningEffort : null,
          };
      const response = await adminFetch(`/api/admin/mcp/tools/${encodeURIComponent(editing.toolType)}`, {
        method: "PUT",
        body: JSON.stringify({ config }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(payload, "保存配置失败"));
      setMessage(`已保存 ${editing.name} 的配置`);
      setEditing(null);
      await resource.refresh();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : "保存配置失败");
    } finally {
      setSaving(false);
    }
  }

  function openTest(tool: MCPTool) {
    setTesting(tool);
    setTestImages([]);
    setTestUrlInput("");
    setTestPrompt("");
    setTestContent("");
    setTestError(null);
    setTestResult(null);
  }

  function addTestImages(sources: string[]) {
    if (!sources.length) return;
    setTestImages((prev) => [...prev, ...sources]);
    setTestError(null);
  }

  function onTestFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    let pending = files.length;
    const results: string[] = [];
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") results.push(reader.result);
        pending -= 1;
        if (pending === 0) addTestImages(results);
      };
      reader.onerror = () => {
        pending -= 1;
        if (pending === 0) addTestImages(results);
        setTestError("部分图片读取失败，请重新选择");
      };
      reader.readAsDataURL(file);
    });
  }

  function onTestPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const images = items
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!images.length) return;
    event.preventDefault();
    let pending = images.length;
    const results: string[] = [];
    images.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") results.push(reader.result);
        pending -= 1;
        if (pending === 0) addTestImages(results);
      };
      reader.onerror = () => {
        pending -= 1;
        if (pending === 0) addTestImages(results);
      };
      reader.readAsDataURL(file);
    });
  }

  function addTestUrl() {
    const url = testUrlInput.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setTestError("图片 URL 必须以 http(s):// 开头");
      return;
    }
    addTestImages([url]);
    setTestUrlInput("");
  }

  function removeTestImage(index: number) {
    setTestImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function runTest(event: FormEvent) {
    event.preventDefault();
    if (!testing) return;
    const isSearch = testing.toolType === "deepseek_web_search";
    if (!isSearch && !testImages.length) {
      setTestError("请至少添加一张图片（URL、上传或粘贴）");
      return;
    }
    if (isSearch && !testContent.trim()) {
      setTestError("请输入要搜索的内容");
      return;
    }
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = isSearch
        ? { content: testContent.trim() }
        : { images: testImages };
      if (!isSearch && testPrompt.trim()) body.prompt = testPrompt.trim();
      const response = await adminFetch(`/api/admin/mcp/tools/${encodeURIComponent(testing.toolType)}/test`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as { result?: { text?: string; model?: string } } | null;
      if (!response.ok) throw new Error(errorMessage(payload, "工具调用失败"));
      setTestResult(payload?.result ?? null);
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : "工具调用失败");
    } finally {
      setTestLoading(false);
    }
  }

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
          <Panel title="MCP 服务信息" description="MCP 客户端连接地址与鉴权方式。">
            <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-[3fr_2fr]">
              <div className="grid auto-rows-fr gap-3 sm:grid-cols-2">
                <InfoCell label="服务端点" mono>{endpoint}</InfoCell>
                <InfoCell label="协议版本" mono>{server?.protocolVersion || "—"}</InfoCell>
                <InfoCell label="工具数量">{server?.toolCount ?? tools.length}</InfoCell>
                <InfoCell label="鉴权方式" mono>Bearer &lt;API Key&gt;
                  <span className="mt-1 block truncate text-[11px] font-normal leading-5 text-muted-foreground">使用「API 密钥」页创建的 API Key，识图消耗该 Key 归属用户的账号池</span>
                </InfoCell>
              </div>
              <div className="min-w-0 rounded-lg border bg-white p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-foreground">客户端接入配置（mcpServers）</p>
                  <Button size="xs" variant="outline" onClick={() => void copyServerConfig()}>
                    {configCopied ? <Check /> : <Copy />}
                    {configCopied ? "已复制" : "复制"}
                  </Button>
                </div>
                <pre className="mt-2 overflow-x-auto rounded-md bg-[#fafafa] p-3 font-mono text-[11px] leading-5">{mcpServerConfig || "…"}</pre>
                <div className="mt-3 space-y-1.5 text-[11px] leading-5 text-muted-foreground">
                  <p>本地桥（npx fusionrouter-mcp）支持传<strong>本地图片路径</strong>，推荐接入方式；远程 URL 直连（<code className="rounded-md border bg-[#fafafa] px-1.5 py-0.5 font-mono text-[10px] text-foreground">{endpoint}</code> + Bearer 鉴权）不支持本地图片。</p>
                  <p>把 <code className="rounded-md border bg-[#fafafa] px-1.5 py-0.5 font-mono text-[10px] text-foreground">&lt;你的 API Key&gt;</code> 替换成「API 密钥」页创建的 Key；识图请求使用该 Key 归属用户的账号池。</p>
                </div>
              </div>
            </div>
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
                    <TableHead>模型</TableHead>
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
                        <div className="flex flex-wrap items-center gap-1.5">
                          {tool.config?.model ? (
                            <span className="font-mono text-xs">{tool.config.model}</span>
                          ) : (
                            <Badge variant="outline" className="border-warning/20 bg-warning-soft text-warning">未配置</Badge>
                          )}
                          {tool.toolType === "deepseek_web_search" ? (
                            tool.config?.provider ? (
                              <Badge variant="outline" className="text-[10px]">{tool.config.provider}</Badge>
                            ) : (
                              <Badge variant="outline" className="border-warning/20 bg-warning-soft text-warning text-[10px]">未选 Provider</Badge>
                            )
                          ) : null}
                          {tool.config?.reasoningEnabled ? (
                            <Badge variant="outline" className="text-[10px]">思考 {tool.config.reasoningEffort || "默认"}</Badge>
                          ) : null}
                        </div>
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
                          <Button variant="outline" size="sm" onClick={() => openTest(tool)}>
                            <Sparkles data-icon="inline-start" />
                            测试
                          </Button>
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

      {/* 编辑工具配置 */}
      <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open && !saving) setEditing(null); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isSearchEditing ? "编辑网页搜索配置" : "编辑识图配置"}</DialogTitle>
            <DialogDescription>{editing ? `${editing.name}（${editing.toolType}）` : ""} — {isSearchEditing ? "配置调用原生 web search 的 Provider 与模型参数。" : "配置识图使用的模型与推理参数。"}</DialogDescription>
          </DialogHeader>
          <form id="mcp-edit-form" onSubmit={(event) => void saveConfig(event)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mcp-provider">{isSearchEditing ? "搜索 Provider" : "识图 Provider"}</Label>
              <Select
                value={isSearchEditing ? provider || undefined : (provider || "auto")}
                onValueChange={(value) => { setProvider(isSearchEditing ? value : (value === "auto" ? "" : value)); setModelInput(""); }}
              >
                <SelectTrigger id="mcp-provider" className="w-full bg-white"><SelectValue placeholder={isSearchEditing ? "选择搜索 Provider" : "选择识图 Provider"} /></SelectTrigger>
                <SelectContent>
                  {!isSearchEditing ? <SelectItem value="auto">自动路由</SelectItem> : null}
                  {catalogs.map((catalog) => (
                    <SelectItem key={catalog.poolType} value={catalog.poolType}>{catalog.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isSearchEditing ? (
                <p className="text-[11px] leading-5 text-muted-foreground">Provider 必选：不按模型自动路由，同一模型在不同 Provider 支持的能力可能不同，请明确指定后自行测试。该工具直连 Provider 的 Anthropic messages 端点（<code className="rounded-md border bg-[#fafafa] px-1 py-0.5 font-mono text-[10px]">/anthropic/v1/messages</code>），需 Provider 支持原生 web search 工具（如 DeepSeek 官方：在「自定义 Provider」添加，baseUrl 填 <code className="rounded-md border bg-[#fafafa] px-1 py-0.5 font-mono text-[10px]">https://api.deepseek.com</code>）。</p>
              ) : (
                <p className="text-[11px] leading-5 text-muted-foreground">留空表示自动路由；选择 Provider 后，下方模型下拉会更新为该 Provider 的模型列表。</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-model">{isSearchEditing ? "搜索模型" : "识图模型"}</Label>
              <Select value={modelInput || undefined} onValueChange={setModelInput}>
                <SelectTrigger id="mcp-model" className="w-full bg-white"><SelectValue placeholder={provider ? "选择模型或手动输入模型名" : "自动路由下请直接输入模型名"} /></SelectTrigger>
                <SelectContent>
                  {modelInput && !modelOptions.includes(modelInput) ? (
                    <SelectItem key={modelInput} value={modelInput}>{modelInput}</SelectItem>
                  ) : null}
                  {modelOptions.map((model) => (
                    <SelectItem key={model} value={model}>{model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input value={modelInput} onChange={(event) => setModelInput(event.target.value)} placeholder={isSearchEditing ? "例如 deepseek-v4-flash" : "例如 minimax-m3 / qwen3.7-plus"} className="font-mono text-xs" aria-label="自定义模型名" />
              {isSearchEditing ? (
                <p className="text-[11px] leading-5 text-muted-foreground">选择 Provider 后下拉会列出其模型目录；支持 web search 的模型请以实测为准，也可直接输入模型名（必填）。</p>
              ) : (
                <p className="text-[11px] leading-5 text-muted-foreground">下拉只列出已验证可识图的多模态模型（minimax-m3、qwen3.7-plus）；如确有特殊模型需求，可在下方直接输入模型名（必填）。</p>
              )}
            </div>
            {!isSearchEditing ? (
              <div className="space-y-2">
                <Label htmlFor="mcp-prompt">默认提示词（可选）</Label>
                <Textarea id="mcp-prompt" rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="留空则使用调用方 AI 传入的问题；调用方也未传时模型直接看图回答" />
              </div>
            ) : null}
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
            {!isSearchEditing ? (
              <>
                <div className="flex items-center gap-2">
                  <Checkbox id="mcp-reasoning" checked={reasoningEnabled} onCheckedChange={(value) => setReasoningEnabled(value === true)} />
                  <Label htmlFor="mcp-reasoning">开启思考</Label>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-reasoning-effort">思考等级（可选）</Label>
                  <Select value={reasoningEffort} onValueChange={setReasoningEffort}>
                    <SelectTrigger id="mcp-reasoning-effort" className="w-full bg-white" disabled={!reasoningEnabled}>
                      <SelectValue placeholder="不指定（默认）" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">不指定（默认）</SelectItem>
                      <SelectItem value="low">低 (low)</SelectItem>
                      <SelectItem value="medium">中 (medium)</SelectItem>
                      <SelectItem value="high">高 (high)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] leading-5 text-muted-foreground">开启思考后透传 reasoning_effort 给模型；部分模型不支持该参数时请保持不指定。</p>
                </div>
              </>
            ) : null}
            {metaLoading ? <p className="text-xs text-muted-foreground">正在加载 Provider 选项…</p> : null}
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

      {/* 测试工具 */}
      <Dialog open={Boolean(testing)} onOpenChange={(open) => { if (!open && !testLoading) setTesting(null); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isSearchTesting ? "测试网页搜索" : "测试识图"}</DialogTitle>
            <DialogDescription>{testing ? `${testing.name}（${testing.toolType}）` : ""} — {isSearchTesting ? "输入内容，验证配置的 Provider 能否执行原生 web search 并返回结果。" : "提交一张图片，验证模型识别效果。"}</DialogDescription>
          </DialogHeader>
          <form id="mcp-test-form" onSubmit={(event) => void runTest(event)} className="space-y-4">
            {isSearchTesting ? (
              <div className="space-y-2">
                <Label htmlFor="mcp-test-content">搜索内容</Label>
                <Textarea id="mcp-test-content" rows={4} value={testContent} onChange={(event) => setTestContent(event.target.value)} placeholder="例如：What is the current price of Bitcoin in USD?" />
                <p className="text-[11px] leading-5 text-muted-foreground">搜索结果由配置的 Provider 模型原样返回；若 Provider 不支持 web search 工具会在此看到上游错误。</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>图片（可多张）</Label>
                <div className="flex gap-2">
                  <Input
                    className="font-mono text-xs"
                    value={testUrlInput}
                    onChange={(event) => setTestUrlInput(event.target.value)}
                    onPaste={onTestPaste}
                    onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTestUrl(); } }}
                    placeholder="粘贴图片或输入 URL，回车添加；也支持 Ctrl+V 直接粘贴剪贴板截图"
                  />
                  <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={addTestUrl} aria-label="添加图片 URL">
                    <Upload />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="mcp-test-file"
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={onTestFileChange}
                    className="h-auto w-auto py-1.5 text-xs"
                  />
                  <span className="text-[11px] leading-5 text-muted-foreground">可多选上传；在输入框内 Ctrl+V 粘贴截图，支持一次粘贴多张。</span>
                </div>
                {testImages.length ? (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {testImages.map((src, index) => (
                      <div key={`${index}-${src.slice(0, 24)}`} className="group relative aspect-square overflow-hidden rounded-md border bg-muted/30">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt={`图片 ${index + 1}`} className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeTestImage(index)}
                          className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                          aria-label={`移除图片 ${index + 1}`}
                        >
                          <X className="size-3" />
                        </button>
                        <span className="absolute bottom-1 left-1 rounded-sm bg-black/50 px-1 text-[10px] text-white">{index + 1}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            {!isSearchTesting ? (
              <div className="space-y-2">
                <Label htmlFor="mcp-test-prompt">提示词（可选）</Label>
                <Textarea id="mcp-test-prompt" rows={2} value={testPrompt} onChange={(event) => setTestPrompt(event.target.value)} placeholder="留空则不附带提示词，模型直接看图回答；多图时可在这里说明对比/分析要求" />
              </div>
            ) : null}
            {testError ? <p className="text-sm text-destructive" role="alert">{testError}</p> : null}
            {testResult ? (
              <div className="space-y-2 rounded-lg border bg-[#fbfbfa] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-sm bg-success-soft px-1.5 py-0.5 text-[10px] text-success">调用完成</span>
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
              {testLoading ? "调用中" : (isSearchTesting ? "运行搜索" : "运行识图")}
            </Button>
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