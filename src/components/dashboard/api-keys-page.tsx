"use client";

import { useState, type FormEvent } from "react";
import { Check, Copy, Eye, KeyRound, MoreHorizontal, Pencil, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageIntro, Panel, EmptyState, ErrorState, LoadingTable, formatDate } from "./page-kit";
import { StatusBadge } from "./status-ui";
import { useAdminResource } from "./use-admin-resource";
import { useAdmin } from "./admin-context";
import { copyToClipboard } from "@/lib/utils";
import type { ApiKeyRecord } from "./types";

interface KeysPayload { keys?: ApiKeyRecord[]; apiKeys?: ApiKeyRecord[] }

export function ApiKeysPage() {
  const resource = useAdminResource<KeysPayload>("/api/admin/keys");
  const { adminFetch } = useAdmin();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState<ApiKeyRecord | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealLoading, setRevealLoading] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealCopied, setRevealCopied] = useState(false);
  const [revealCopyError, setRevealCopyError] = useState<string | null>(null);
  const [renameKey, setRenameKey] = useState<ApiKeyRecord | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const keys = resource.data?.keys ?? resource.data?.apiKeys ?? [];

  function reset(next: boolean) { setOpen(next); if (!next) { setName(""); setExpiresAt(""); setSecret(null); setError(null); setCopied(false); setCopyError(null); } }

  async function copySecret(value: string, revealedSecret = false) {
    if (revealedSecret) { setRevealCopied(false); setRevealCopyError(null); }
    else { setCopied(false); setCopyError(null); }
    const ok = await copyToClipboard(value);
    if (revealedSecret) {
      if (ok) setRevealCopied(true);
      else setRevealCopyError("复制失败，请长按上方密钥手动复制");
    } else if (ok) setCopied(true);
    else setCopyError("复制失败，请长按上方密钥手动复制");
  }

  async function create(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const response = await adminFetch("/api/admin/keys", { method: "POST", body: JSON.stringify({ name: name.trim(), expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || payload?.message || "密钥创建失败");
      setSecret(payload?.apiKey?.key || payload?.key || null);
      await resource.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "密钥创建失败"); }
    finally { setSaving(false); }
  }

  async function toggle(key: ApiKeyRecord) {
    const response = await adminFetch(`/api/admin/keys/${encodeURIComponent(key.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !(key.enabled ?? key.status === "active") }) });
    if (response.ok) await resource.refresh();
  }

  async function remove(key: ApiKeyRecord) {
    if (!window.confirm(`确认吊销 ${key.name || key.alias || key.prefix || key.id}？此操作不可恢复。`)) return;
    const response = await adminFetch(`/api/admin/keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
    if (response.ok) await resource.refresh();
  }

  async function openReveal(key: ApiKeyRecord) {
    setRevealKey(key); setRevealed(null); setRevealError(null); setRevealCopied(false); setRevealCopyError(null); setRevealLoading(true);
    try {
      const response = await adminFetch(`/api/admin/keys/${encodeURIComponent(key.id)}/reveal`);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "无法查看明文");
      setRevealed(payload?.key ?? null);
    } catch (cause) {
      setRevealError(cause instanceof Error ? cause.message : "无法查看明文");
    } finally {
      setRevealLoading(false);
    }
  }

  function closeReveal() {
    setRevealKey(null); setRevealed(null); setRevealError(null); setRevealCopied(false); setRevealCopyError(null);
  }

  function openRename(key: ApiKeyRecord) {
    setRenameKey(key); setRenameName(key.name || key.alias || ""); setRenameError(null);
  }

  function closeRename() {
    if (renameSaving) return;
    setRenameKey(null); setRenameName(""); setRenameError(null);
  }

  async function renameApiKey(event: FormEvent) {
    event.preventDefault();
    if (!renameKey) return;
    const nextName = renameName.trim();
    if (nextName.length < 1 || nextName.length > 100) {
      setRenameError("名称长度必须为 1–100 个字符");
      return;
    }
    setRenameSaving(true); setRenameError(null);
    try {
      const response = await adminFetch(`/api/admin/keys/${encodeURIComponent(renameKey.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nextName }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || "重命名失败");
      await resource.refresh();
      setRenameKey(null); setRenameName("");
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : "重命名失败");
    } finally {
      setRenameSaving(false);
    }
  }

  return <>
    <PageIntro eyebrow="CLIENT ACCESS" title="API 密钥" description="统一 API 密钥既用于外部模型请求，也用于浏览器插件确认账号归属。可随时查看明文并复制。" actions={<><Button variant="outline" size="sm" onClick={() => void resource.refresh()}><RefreshCw data-icon="inline-start" />刷新</Button><Button size="sm" onClick={() => setOpen(true)}><Plus data-icon="inline-start" />创建密钥</Button></>} />
    <Panel title="客户端密钥" description={`${keys.length} 个密钥。建议按客户端或环境单独签发。`}>
      {resource.loading ? <LoadingTable rows={5} columns={6} /> : resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()} /> : !keys.length ? <EmptyState title="还没有 API 密钥" description="创建密钥后，外部客户端即可通过统一入口访问账号池。" action={<Button size="sm" onClick={() => setOpen(true)}><KeyRound data-icon="inline-start" />创建第一个密钥</Button>} /> : <Table className="min-w-[820px]"><TableHeader className="bg-[#fafafa]"><TableRow><TableHead className="px-4 text-xs text-muted-foreground">名称</TableHead><TableHead className="text-xs text-muted-foreground">前缀</TableHead><TableHead className="text-xs text-muted-foreground">状态</TableHead><TableHead className="text-xs text-muted-foreground">到期</TableHead><TableHead className="text-xs text-muted-foreground">最近使用</TableHead><TableHead className="text-right text-xs text-muted-foreground">请求数</TableHead><TableHead className="w-14 px-4" /></TableRow></TableHeader><TableBody>{keys.map((key) => <TableRow key={key.id}><TableCell className="px-4 font-medium">{key.name || key.alias || "未命名密钥"}</TableCell><TableCell className="font-mono text-xs text-muted-foreground">{key.prefix || key.keyPrefix || key.id}</TableCell><TableCell><StatusBadge status={key.enabled === false ? "disabled" : key.status || "active"} /></TableCell><TableCell className="font-mono text-xs text-muted-foreground">{key.expiresAt ? formatDate(key.expiresAt) : "永不过期"}</TableCell><TableCell className="font-mono text-xs text-muted-foreground">{formatDate(key.lastUsedAt)}</TableCell><TableCell className="tabular text-right font-mono text-xs">{key.requestCount ?? key.useCount ?? 0}</TableCell><TableCell className="px-4 text-right"><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="密钥操作"><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => openRename(key)}><Pencil />重命名</DropdownMenuItem><DropdownMenuItem onSelect={() => void openReveal(key)}><Eye />查看明文</DropdownMenuItem><DropdownMenuItem onSelect={() => void toggle(key)}><Power />{key.enabled === false ? "启用" : "停用"}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onSelect={() => void remove(key)}><Trash2 />吊销密钥</DropdownMenuItem></DropdownMenuContent></DropdownMenu></TableCell></TableRow>)}</TableBody></Table>}
    </Panel>
    <Dialog open={open} onOpenChange={reset}><DialogContent showCloseButton={!secret}><DialogHeader><DialogTitle>{secret ? "立即保存 API 密钥" : "创建 API 密钥"}</DialogTitle><DialogDescription>{secret ? "关闭后无法再次查看完整密钥。" : "为每个客户端使用独立密钥，便于单独吊销。"}</DialogDescription></DialogHeader>{secret ? <div className="space-y-3"><div className="select-all break-all rounded-md border bg-[#fafafa] p-3 font-mono text-xs leading-5">{secret}</div><Button variant="outline" className="w-full" onClick={() => void copySecret(secret)}>{copied ? <Check /> : <Copy />}{copied ? "已复制" : "复制密钥"}</Button>{copyError ? <p className="text-center text-xs text-destructive" role="alert">{copyError}</p> : null}</div> : <form id="create-key-form" onSubmit={create} className="space-y-4"><div className="space-y-2"><Label htmlFor="key-name">名称</Label><Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="production" required /></div><div className="space-y-2"><Label htmlFor="key-expires">到期时间，可选</Label><Input id="key-expires" type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} /></div>{error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}</form>}<DialogFooter>{secret ? <Button onClick={() => reset(false)}>我已安全保存</Button> : <><Button variant="outline" onClick={() => reset(false)}>取消</Button><Button type="submit" form="create-key-form" disabled={saving}>{saving ? "正在创建" : "创建"}</Button></>}</DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(revealKey)} onOpenChange={(o) => { if (!o) closeReveal(); }}><DialogContent><DialogHeader><DialogTitle>查看明文</DialogTitle><DialogDescription>{revealKey ? `${revealKey.name || revealKey.alias || revealKey.prefix || revealKey.id} · 仅本次会话可见` : ""}</DialogDescription></DialogHeader>{revealLoading ? <div className="py-6 text-center text-sm text-muted-foreground">正在解密…</div> : revealError ? <p className="text-sm text-destructive" role="alert">{revealError}</p> : revealed ? <div className="space-y-3"><div className="select-all break-all rounded-md border bg-[#fafafa] p-3 font-mono text-xs leading-5">{revealed}</div><Button variant="outline" className="w-full" onClick={() => void copySecret(revealed, true)}>{revealCopied ? <Check /> : <Copy />}{revealCopied ? "已复制" : "复制密钥"}</Button>{revealCopyError ? <p className="text-center text-xs text-destructive" role="alert">{revealCopyError}</p> : null}</div> : null}<DialogFooter><Button onClick={closeReveal}>关闭</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(renameKey)} onOpenChange={(nextOpen) => { if (!nextOpen) closeRename(); }}><DialogContent><DialogHeader><DialogTitle>重命名 API 密钥</DialogTitle><DialogDescription>只修改显示名称，不会改变密钥内容或调用方式。</DialogDescription></DialogHeader><form id="rename-key-form" onSubmit={renameApiKey} className="space-y-4"><div className="space-y-2"><Label htmlFor="rename-key-name">名称</Label><Input id="rename-key-name" value={renameName} onChange={(event) => setRenameName(event.target.value)} minLength={1} maxLength={100} autoFocus required /></div>{renameError ? <p className="text-sm text-destructive" role="alert">{renameError}</p> : null}</form><DialogFooter><Button variant="outline" onClick={closeRename} disabled={renameSaving}>取消</Button><Button type="submit" form="rename-key-form" disabled={renameSaving || renameName.trim().length < 1 || renameName.trim().length > 100}>{renameSaving ? "正在保存" : "保存名称"}</Button></DialogFooter></DialogContent></Dialog>
  </>;
}
