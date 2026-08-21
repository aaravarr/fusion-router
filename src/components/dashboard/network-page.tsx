"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ChevronRight, Network, PenLine, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "./admin-context";
import { PROVIDER_DOMAIN_PRESETS } from "./domain-presets";
import { ErrorState, PageIntro, Panel } from "./page-kit";
import { getPoolLabel } from "./status-ui";
import { useConfirm } from "@/components/ui/confirm-provider";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface MirrorTarget { id: string; name: string; url: string; enabled: boolean }
interface MirrorRule { id: string; pattern: string; mirrorId: string; enabled: boolean }
interface RequestMirrorRule { id: string; enabled: boolean; source: "body" | "header"; field: string; operator: "equals" | "notEquals" | "contains" | "startsWith"; value: string }
interface RequestMirrorRuleGroup { id: string; enabled: boolean; mirrorId: string; condition: "and" | "or"; rules: RequestMirrorRule[] }
interface MirrorAccount { id: string; name: string; email?: string | null; poolType: string; poolLabel?: string | null; workspaceId?: string | null }
interface MirrorGroup { id: string; name: string; enabled: boolean; domains: string[]; accountIds: string[]; mirrors: MirrorTarget[]; rules: MirrorRule[]; requestRules?: RequestMirrorRuleGroup[] }
interface NetworkPayload { groups?: MirrorGroup[]; accounts?: MirrorAccount[] }

function newId(prefix: string) {
  return `${prefix}_${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
}

export function NetworkPage() {
  const { sessionFetch } = useSession();
  const [data, setData] = useState<NetworkPayload | null>(null);
  const [draft, setDraft] = useState<MirrorGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 镜像组编辑对话框的受控状态：null = 关闭，{ group } = 编辑，{} = 新建
  const [editorGroup, setEditorGroup] = useState<MirrorGroup | null | undefined>(undefined);
  const editor = {
    open: (target: { group?: MirrorGroup }) =>
      setEditorGroup(target.group ?? null),
    close: () => setEditorGroup(undefined),
    current: editorGroup,
  };

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const response = await sessionFetch("/api/network");
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "加载失败");
      setData(payload);
      setDraft(payload.groups ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = draft ?? data?.groups ?? [];
  const accounts = data?.accounts ?? [];

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const response = await sessionFetch("/api/network", {
        method: "PUT",
        body: JSON.stringify({ groups }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || "保存失败");
      setDraft(payload.groups);
      setData((current) => ({ ...(current ?? {}), groups: payload.groups }));
      setMessage("镜像路由已保存，即时生效");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageIntro
        eyebrow="NETWORK"
        title="网络"
        showTitle={false}
        description="按账号组管理域名镜像路由；每个用户只管理自己的镜像组与账号，未命中时按账号 ID 稳定 Hash。"
        actions={
          <>
            <Button size="sm" onClick={() => editor.open({})}>
              <Plus data-icon="inline-start" />
              新建镜像组
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw data-icon="inline-start" />
              重新载入
            </Button>
          </>
        }
      />
      {error ? (
        <Panel>
          <ErrorState message={error} onRetry={() => void load()} />
        </Panel>
      ) : null}
      {loading && !data ? <Panel><div className="p-4 text-sm text-muted-foreground">加载中…</div></Panel> : null}
      {!loading && !error && groups.length === 0 ? (
        <div className="mb-4 flex min-h-52 flex-col items-center justify-center rounded-lg border border-border px-6 py-12 text-center">
          <div className="mb-4 grid size-9 place-items-center rounded-md border bg-[#fafafa]">
            <Network className="size-4 text-muted-foreground" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-medium">还没有镜像组</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
            为你的账号配置备用线路：将上游请求按域名分流到代理或镜像节点，在官方端点不稳定时自动切换。
          </p>
          <div className="mt-5">
            <Button size="sm" onClick={() => editor.open({})}>
              <Plus data-icon="inline-start" />
              新建镜像组
            </Button>
          </div>
          <a
            href="#"
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-accent-blue hover:underline"
          >
            了解镜像组的典型用法
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        </div>
      ) : null}
      {groups.length > 0 || loading ? (
        <Panel
          title="域名镜像路由"
          description="每组包含一批账号、多个原始域名和多个镜像节点；组内先按正则规则选择节点，未命中时按账号 ID 稳定 Hash。"
        >
          <div className="p-4 sm:p-5">
            <DomainMirrorsEditor
              value={groups}
              editor={editor}
              onChange={(value) => setDraft(value)}
            />
          </div>
        </Panel>
      ) : null}
      <div className="sticky bottom-4 flex flex-col gap-3 rounded-lg border bg-white/95 p-3 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground" role="status">
          {message || "镜像路由保存在持久数据目录和数据库中。"}
        </p>
        <Button onClick={() => void save()} disabled={saving || loading} className="w-full sm:w-auto shrink-0">
          <Save data-icon="inline-start" />
          {saving ? "正在保存" : "保存镜像路由"}
        </Button>
      </div>
      <div className="h-6" aria-hidden="true" />
      {editorGroup !== undefined ? (
        <MirrorGroupDialog
          key={editorGroup?.id ?? "new"}
          group={editorGroup}
          groups={groups}
          accounts={accounts}
          onClose={() => setEditorGroup(undefined)}
          onSave={(group) => {
            setDraft(
              editorGroup
                ? groups.map((item) => (item.id === editorGroup.id ? group : item))
                : [...groups, group],
            );
            setEditorGroup(undefined);
          }}
        />
      ) : null}
    </>
  );
}

interface EditorControl {
  open: (target: { group?: MirrorGroup }) => void;
  close: () => void;
  current: MirrorGroup | null | undefined;
}

function DomainMirrorsEditor({ value, editor, onChange }: { value: MirrorGroup[]; editor: EditorControl; onChange: (value: MirrorGroup[]) => void }) {
  const confirm = useConfirm();
  const groups = value;
  async function removeGroup(id: string) {
    const group = groups.find((item) => item.id === id);
    const approved = await confirm({ title: `删除镜像组${group?.name ? `“${group.name}”` : ""}？`, description: "组内的域名、规则和账号绑定会一起移除。保存设置后生效。", confirmText: "删除镜像组", destructive: true });
    if (!approved) return;
    onChange(groups.filter((group) => group.id !== id));
  }
  function setGroupEnabled(id: string, enabled: boolean) {
    onChange(groups.map((group) => (group.id === id ? { ...group, enabled } : group)));
  }
  if (!groups.length) return (
    <div className="rounded-md border border-border px-4 py-8 text-center text-xs text-muted-foreground">
      暂无镜像组
    </div>
  );
  return (
    <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((group) => (
        <div key={group.id} className="flex flex-col overflow-hidden rounded-lg border bg-white transition-colors hover:border-border-strong">
          <div className="flex items-start justify-between gap-2 border-b px-3.5 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold tracking-[-0.01em]">{group.name}</p>
              <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{group.id}</p>
            </div>
            <Switch checked={group.enabled} onCheckedChange={(checked) => setGroupEnabled(group.id, checked)} />
          </div>
          <div className="flex flex-1 flex-col gap-2.5 px-3.5 py-3">
            <div>
              <p className="mb-1 text-[10.5px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">原始域名</p>
              <div className="flex flex-wrap gap-1">
                {group.domains.slice(0, 3).map((domain) => (
                  <span key={domain} className="rounded border bg-[#f7f7f5] px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{domain}</span>
                ))}
                {group.domains.length > 3 ? <span className="rounded border border-dashed px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">+{group.domains.length - 3}</span> : null}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10.5px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">绑定账号</p>
              <div className="flex flex-wrap gap-1">
                <span className="rounded border bg-[#f7f7f5] px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{group.accountIds.length ? "已选 " + group.accountIds.length + " 个" : "全部账号"}</span>
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10.5px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">镜像目标</p>
              <div className="space-y-1">
                {group.mirrors.map((mirror) => (
                  <div key={mirror.id} className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
                    <span className={`size-[7px] shrink-0 rounded-full ${mirror.enabled ? "bg-success" : "bg-[#d6d6d4]"}`} aria-hidden="true" />
                    <span className="font-medium">{mirror.name}</span>
                    <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground">{mirror.url}</span>
                  </div>
                ))}
                {!group.mirrors.length ? <span className="text-xs text-muted-foreground">无节点</span> : null}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[10.5px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">规则</p>
              <p className="font-mono text-[11px] text-muted-foreground">{group.rules.length} 条路由规则 · {group.requestRules?.length ?? 0} 组请求规则</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 border-t bg-[#fafafa] px-3.5 py-2">
            <button type="button" onClick={() => editor.open({ group })} className="inline-flex h-[26px] items-center gap-1 rounded px-2 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted">
              <PenLine className="size-3" />编辑
            </button>
            <span className="flex-1" />
            <button type="button" onClick={() => removeGroup(group.id)} className="inline-flex h-[26px] items-center gap-1 rounded px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10">
              <Trash2 className="size-3" />删除
            </button>
          </div>
        </div>
      ))}
    </div>
  );
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
  const [requestRules, setRequestRules] = useState<RequestMirrorRuleGroup[]>(group?.requestRules ?? []);
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
  function removeMirror(id: string) { setMirrors((current) => current.filter((mirror) => mirror.id !== id)); setRules((current) => current.filter((rule) => rule.mirrorId !== id)); setRequestRules((current) => current.filter((group) => group.mirrorId !== id)); if (ruleMirrorId === id) setRuleMirrorId(""); }
  const valid = Boolean(name.trim() && domains.size && mirrors.length);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[calc(100dvh-48px)] flex-col overflow-hidden p-0 sm:max-w-[860px]">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{group ? "编辑镜像组" : "新增镜像组"}</DialogTitle>
          <DialogDescription>先选定这组账号，再为该组配置多个镜像节点与节点选择规则。保存后即时生效。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="space-y-5">
            <div>
              <Label className="text-[12.5px] font-semibold">组名称</Label>
              <Input className="mt-1.5" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如 XAI 账号组" />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border bg-[#fafafa] px-3 py-2.5">
              <span className="text-[12.5px] font-semibold text-foreground">启用这个镜像组</span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div>
              <Label className="flex items-center justify-between text-[12.5px] font-semibold">
                <span>绑定账号</span>
                <span className="text-[11.5px] font-medium text-muted-foreground">已选 {accountIds.size} 个 · 仅显示你名下的账号</span>
              </Label>
              <div className="mt-1.5 overflow-hidden rounded-md border">
                <Input className="h-8 rounded-none border-0 text-xs focus-visible:ring-0" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索账号" />
                <div className="max-h-44 overflow-y-auto border-t bg-white">
                  {filteredAccounts.map((account) => (
                    <label key={account.id} className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-xs transition-colors hover:bg-muted/40 last:border-b-0">
                      <Checkbox checked={accountIds.has(account.id)} onCheckedChange={() => toggle(setAccountIds, account.id)} />
                      <span className="min-w-0 flex-1 truncate">{account.name || account.email || account.id}</span>
                      <span className="text-[11px] text-muted-foreground">{getPoolLabel(account.poolType, account.poolLabel)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <Label className="flex items-center justify-between text-[12.5px] font-semibold">
                <span>原始域名</span>
                <span className="text-[11.5px] font-medium text-muted-foreground">已选 {domains.size} 个</span>
              </Label>
              <div className="mt-1.5 grid max-h-44 gap-1 overflow-y-auto rounded-md border bg-white p-2 sm:grid-cols-2">
                {knownDomains.map((domain) => {
                  const preset = presetDomains.find((item) => item.domain === domain);
                  return (
                    <label key={domain} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-muted/40">
                      <Checkbox checked={domains.has(domain)} onCheckedChange={() => toggle(setDomains, domain)} />
                      <span className="min-w-0 truncate font-mono">{domain}</span>
                      {preset ? <span className="ml-auto truncate text-[10px] text-muted-foreground">{preset.label}</span> : null}
                    </label>
                  );
                })}
              </div>
              <div className="mt-2 flex gap-2">
                <Input className="h-8 flex-1 font-mono text-xs" value={customDomain} onChange={(event) => setCustomDomain(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addCustomDomain(); } }} placeholder="添加域名，如 custom.example.com" />
                <Button type="button" variant="outline" size="sm" onClick={addCustomDomain} disabled={!customDomain.trim()}>添加</Button>
              </div>
            </div>
            <div>
              <Label className="flex items-center justify-between text-[12.5px] font-semibold">
                <span>镜像目标</span>
                <span className="text-[11.5px] font-medium text-muted-foreground">{mirrors.length} 个节点</span>
              </Label>
              <div className="mt-1.5 space-y-0">
                {mirrors.map((mirror) => (
                  <div key={mirror.id} className="grid items-center gap-2 py-1.5 sm:grid-cols-[18px_1.2fr_1.6fr_26px]">
                    <button
                      type="button"
                      className={cn("relative mx-auto grid size-[15px] place-items-center rounded-[3px] border-[1.5px] text-white before:absolute before:-inset-3 before:content-['']", mirror.enabled ? "border-accent-blue bg-accent-blue" : "border-[#d6d6d4] bg-white")}
                      onClick={() => setMirrors((current) => current.map((item) => item.id === mirror.id ? { ...item, enabled: !item.enabled } : item))}
                      aria-label={mirror.enabled ? "停用节点" : "启用节点"}
                    >
                      <Check className={cn("size-2.5", mirror.enabled ? "opacity-100" : "opacity-0")} strokeWidth={3} />
                    </button>
                    <Input className="h-8 text-xs" value={mirror.name} onChange={(event) => setMirrors((current) => current.map((item) => item.id === mirror.id ? { ...item, name: event.target.value } : item))} placeholder="节点名称" />
                    <Input className="h-8 font-mono text-xs" value={mirror.url} onChange={(event) => setMirrors((current) => current.map((item) => item.id === mirror.id ? { ...item, url: event.target.value } : item))} placeholder="https://mirror.example.com/$host" />
                    <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive" onClick={() => removeMirror(mirror.id)} aria-label="删除节点"><Trash2 /></Button>
                  </div>
                ))}
                <div className="grid items-center gap-2 border-t py-1.5 sm:grid-cols-[18px_1.2fr_1.6fr_auto]">
                  <span aria-hidden="true" />
                  <Input className="h-8 text-xs" value={mirrorName} onChange={(event) => setMirrorName(event.target.value)} placeholder="节点名称" />
                  <Input className="h-8 font-mono text-xs" value={mirrorUrl} onChange={(event) => setMirrorUrl(event.target.value)} placeholder="https://mirror.example.com/$host" />
                  <button
                    type="button"
                    onClick={() => { if (mirrorName.trim() && mirrorUrl.trim()) { setMirrors((current) => [...current, { id: newId("mirror"), name: mirrorName.trim(), url: mirrorUrl.trim(), enabled: true }]); setMirrorName(""); setMirrorUrl(""); } }}
                    className="inline-flex min-w-16 shrink-0 items-center gap-1.5 rounded border border-dashed border-accent-blue-soft-2 px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-accent-blue transition-colors hover:bg-accent-blue-soft"
                  >
                    <Plus className="size-3.5" />添加
                  </button>
                </div>
              </div>
            </div>
            <details className="overflow-hidden rounded-md border" open>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-[12.5px] font-semibold text-foreground/80 select-none hover:bg-muted [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90" />
                高级规则
                <span className="ml-auto font-mono text-[11px] font-medium text-muted-foreground">{rules.length} 条路由规则 · {requestRules.length} 组请求规则</span>
              </summary>
              <div className="space-y-4 border-t bg-[#fafafa] px-3.5 py-3">
                <AdvancedRulesEditor rules={rules} mirrors={mirrors} onChange={setRules} ruleMirrorId={ruleMirrorId} setRuleMirrorId={setRuleMirrorId} pattern={pattern} setPattern={setPattern} />
                <RequestRulesEditor value={requestRules} mirrors={mirrors} onChange={setRequestRules} />
              </div>
            </details>
          </div>
        </div>
        <DialogFooter className="border-t bg-[#fafafa] px-5">
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="button" disabled={!valid} onClick={() => onSave({ id: group?.id ?? newId("group"), name: name.trim(), enabled, domains: [...domains], accountIds: [...accountIds], mirrors, rules, requestRules })}>保存镜像组</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestRulesEditor({ value, mirrors, onChange }: { value: RequestMirrorRuleGroup[]; mirrors: MirrorTarget[]; onChange: (next: RequestMirrorRuleGroup[]) => void }) {
  function updateGroup(index: number, next: RequestMirrorRuleGroup) { onChange(value.map((item, i) => (i === index ? next : item))) }
  function updateRule(groupIndex: number, ruleIndex: number, next: RequestMirrorRule) {
    updateGroup(groupIndex, { ...value[groupIndex], rules: value[groupIndex].rules.map((item, i) => (i === ruleIndex ? next : item)) })
  }
  return (
    <div>
      <p className="mb-2 text-[12.5px] font-semibold text-foreground/80">请求规则（{value.length} 组）</p>
      <p className="mb-2 text-[11.5px] leading-5 text-muted-foreground">按请求体/请求头匹配选择镜像，优先于账号路由规则；未命中时回退账号规则/Hash。例如 body.model 包含 gpt 的请求走指定镜像。</p>
      <div className="space-y-3">
        {value.map((group, groupIndex) => (
          <div key={group.id} className="rounded-md border bg-[#fafafa] p-3">
            <div className="mb-2 flex items-center gap-2">
              <Checkbox checked={group.enabled} onCheckedChange={(v) => updateGroup(groupIndex, { ...group, enabled: v === true })} />
              <span className="text-xs font-medium">规则组 {groupIndex + 1}</span>
              <span className="text-xs text-muted-foreground">连接</span>
              <select
                value={group.condition}
                onChange={(e) => updateGroup(groupIndex, { ...group, condition: e.target.value as "and" | "or" })}
                className="h-7 rounded border bg-white px-1 text-xs"
              >
                <option value="and">AND（全部满足）</option>
                <option value="or">OR（任一满足）</option>
              </select>
              <span className="ml-auto flex items-center gap-1">
                <span className="text-xs text-muted-foreground">命中→</span>
                <MirrorSelect mirrors={mirrors} value={group.mirrorId} onChange={(mirrorId) => updateGroup(groupIndex, { ...group, mirrorId })} />
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, i) => i !== groupIndex))}><Trash2 /></Button>
              </span>
            </div>
            <div className="space-y-1.5">
              {group.rules.map((rule, ruleIndex) => (
                <div key={rule.id} className="grid items-center gap-2 sm:grid-cols-[28px_110px_1fr_120px_1fr_34px]">
                  <Checkbox checked={rule.enabled} onCheckedChange={(v) => updateRule(groupIndex, ruleIndex, { ...rule, enabled: v === true })} />
                  <select
                    value={rule.source}
                    onChange={(e) => updateRule(groupIndex, ruleIndex, { ...rule, source: e.target.value as "body" | "header" })}
                    className="h-7 rounded border bg-white px-1 text-xs"
                  >
                    <option value="body">请求体</option>
                    <option value="header">请求头</option>
                  </select>
                  <Input className="h-7 font-mono text-xs" value={rule.field} onChange={(e) => updateRule(groupIndex, ruleIndex, { ...rule, field: e.target.value })} placeholder="字段名，如 model" />
                  <select
                    value={rule.operator}
                    onChange={(e) => updateRule(groupIndex, ruleIndex, { ...rule, operator: e.target.value as RequestMirrorRule["operator"] })}
                    className="h-7 rounded border bg-white px-1 text-xs"
                  >
                    <option value="equals">=</option>
                    <option value="notEquals">!=</option>
                    <option value="contains">包含</option>
                    <option value="startsWith">前缀</option>
                  </select>
                  <Input className="h-7 font-mono text-xs" value={rule.value} onChange={(e) => updateRule(groupIndex, ruleIndex, { ...rule, value: e.target.value })} placeholder="内容，如 gpt" />
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => updateGroup(groupIndex, { ...group, rules: group.rules.filter((_, i) => i !== ruleIndex) })}><Trash2 /></Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => updateGroup(groupIndex, { ...group, rules: [...group.rules, { id: newId("reqrule"), enabled: true, source: "body", field: "", operator: "contains", value: "" }] })}>
                  <Plus />添加规则行
                </Button>
              </div>
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { id: newId("reqgroup"), enabled: true, mirrorId: mirrors[0]?.id ?? "", condition: "or", rules: [{ id: newId("reqrule"), enabled: true, source: "body", field: "model", operator: "contains", value: "" }] }])}>
          <Plus />添加规则组
        </Button>
      </div>
    </div>
  )
}

interface AdvancedRulesEditorProps {
  rules: MirrorRule[];
  mirrors: MirrorTarget[];
  onChange: (rules: MirrorRule[]) => void;
  ruleMirrorId: string;
  setRuleMirrorId: (id: string) => void;
  pattern: string;
  setPattern: (pattern: string) => void;
}

function AdvancedRulesEditor({ rules, mirrors, onChange, ruleMirrorId, setRuleMirrorId, pattern, setPattern }: AdvancedRulesEditorProps) {
  return (
    <div>
      <p className="mb-2 text-[12.5px] font-semibold text-foreground/80">路由规则</p>
      <div className="space-y-2">
        {rules.map((rule) => (
          <div key={rule.id} className="grid items-center gap-2 sm:grid-cols-[28px_1fr_150px_34px]">
            <Checkbox checked={rule.enabled} onCheckedChange={(value) => onChange(rules.map((item) => item.id === rule.id ? { ...item, enabled: value === true } : item))} />
            <Input className="h-8 font-mono text-xs" value={rule.pattern} onChange={(event) => onChange(rules.map((item) => item.id === rule.id ? { ...item, pattern: event.target.value } : item))} />
            <MirrorSelect mirrors={mirrors} value={rule.mirrorId} onChange={(mirrorId) => onChange(rules.map((item) => item.id === rule.id ? { ...item, mirrorId } : item))} />
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(rules.filter((item) => item.id !== rule.id))}><Trash2 /></Button>
          </div>
        ))}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_150px_auto]">
        <Input className="h-8 font-mono text-xs" value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="例如 ^prod- 或 @example\.com$" />
        <MirrorSelect mirrors={mirrors} value={ruleMirrorId} onChange={setRuleMirrorId} />
        <Button type="button" variant="outline" size="sm" disabled={!pattern.trim() || !ruleMirrorId} onClick={() => { onChange([...rules, { id: newId("rule"), pattern: pattern.trim(), mirrorId: ruleMirrorId, enabled: true }]); setPattern(""); }}><Plus />规则</Button>
      </div>
    </div>
  );
}

function MirrorSelect({ mirrors, value, onChange }: { mirrors: MirrorTarget[]; value: string; onChange: (value: string) => void }) {
  return <Select value={value || "none"} onValueChange={(next) => onChange(next === "none" ? "" : next)}><SelectTrigger className="w-full bg-white text-xs"><SelectValue placeholder="选择节点" /></SelectTrigger><SelectContent><SelectItem value="none">选择节点</SelectItem>{mirrors.map((mirror) => <SelectItem key={mirror.id} value={mirror.id}>{mirror.name}</SelectItem>)}</SelectContent></Select>;
}