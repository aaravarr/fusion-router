"use client";

import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAdminResource } from "./use-admin-resource";
import { EmptyState, ErrorState, LoadingTable, PageIntro, Panel, formatDate } from "./page-kit";
import { AccountBadges, BillingSafetyBadge, getQuota, PoolTypeBadge, QuotaStatus } from "./status-ui";
import type { Account } from "./types";

export function UserAccountsPage({ userId }: { userId: string }) {
  const resource = useAdminResource<{ accounts?: Account[] }>(`/api/admin/users/${encodeURIComponent(userId)}/accounts`);
  const accounts = resource.data?.accounts ?? [];
  return <>
    <PageIntro eyebrow="ADMIN INSPECTION" title="用户账号状态" description="管理员只读查看该用户的订阅、认证与额度状态。这些账号不会加入管理员自己的路由池。" actions={<><Button asChild variant="outline" size="sm"><Link href="/users"><ArrowLeft/>返回用户</Link></Button><Button variant="outline" size="sm" onClick={() => void resource.refresh()}><RefreshCw/>刷新</Button></>}/>
    <Panel title="Provider 账号" description={`${accounts.length} 个账号，仅查看。`}>
      {resource.loading ? <LoadingTable rows={5} columns={6}/> : resource.error ? <ErrorState message={resource.error} onRetry={() => void resource.refresh()}/> : !accounts.length ? <EmptyState title="该用户尚未连接账号" description="用户通过浏览器插件完成 Google 登录后会显示在这里。"/> : (
        <Table className="min-w-[920px]"><TableHeader className="bg-[#fafafa]"><TableRow><TableHead className="px-4">账号</TableHead><TableHead>号池</TableHead><TableHead>状态</TableHead><TableHead>主额度窗口</TableHead><TableHead>次额度窗口</TableHead><TableHead>凭据 / 计费</TableHead><TableHead>最近请求</TableHead></TableRow></TableHeader><TableBody>
          {accounts.map((account) => <TableRow key={account.id}><TableCell className="px-4"><p className="text-sm font-medium">{account.name || account.email || account.id}</p></TableCell><TableCell><PoolTypeBadge poolType={account.poolType} label={account.poolLabel}/></TableCell><TableCell><AccountBadges account={account}/></TableCell><TableCell>{account.poolType === "xai-grok" ? <QuotaStatus label="24H" quota={getQuota(account, "rolling24h")}/> : account.poolType === "open-design-go" ? <QuotaStatus label="MONTH" quota={getQuota(account, "monthly")}/> : <QuotaStatus label="5H" quota={getQuota(account, "fiveHour")}/>}</TableCell><TableCell>{account.poolType === "xai-grok" || account.poolType === "open-design-go" ? <span className="text-xs text-muted-foreground">—</span> : <QuotaStatus label="WEEK" quota={getQuota(account, "weekly")}/>}</TableCell><TableCell><BillingSafetyBadge account={account}/></TableCell><TableCell className="font-mono text-xs text-muted-foreground">{formatDate(account.lastRequestAt)}</TableCell></TableRow>)}
        </TableBody></Table>
      )}
    </Panel>
  </>;
}
