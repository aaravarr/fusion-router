import { getDatabase } from "@/server/db";
import { AccountRepository } from "@/server/repository";
import { requireAdministrator } from "../../../_auth";
import { deriveAccountRouteStatus } from "@/server/account-route-state";
import { CustomProviderRepository } from "@/server/custom-providers";
import { tryGetProvider } from "@/server/providers";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = requireAdministrator(request); if (actor instanceof Response) return actor;
  const { id } = await context.params; const db = getDatabase(); const accounts = new AccountRepository(id, db).list();
  const customProviders = new CustomProviderRepository(id, db).list();
  const customProviderEnabled = new Map(customProviders.map((provider) => [provider.poolType, provider.enabled]));
  const windows = db.prepare("SELECT q.account_id,q.kind,q.usage_percent AS usagePercent,q.reset_at AS resetAt,q.source,q.last_observed_at AS lastObservedAt,q.limit_value AS limitValue,q.remaining_value AS remainingValue FROM quota_windows q JOIN accounts a ON a.id=q.account_id WHERE a.owner_user_id=?").all(id) as Array<Record<string, unknown>>;
  return Response.json({ accounts: accounts.map((account) => {
    const accountWindows = windows.filter((window) => window.account_id === account.id).map((window) => ({
      ...window,
      usagePercent: window.usagePercent == null ? null : Number(window.usagePercent),
      resetAt: typeof window.resetAt === "string" ? window.resetAt : null,
    }));
    const provider = tryGetProvider(account.poolType);
    const customEnabled = account.poolType.startsWith("custom:") ? customProviderEnabled.get(account.poolType) === true : true;
    const providerReady = customEnabled && Boolean(provider?.isAccountReady(account));
    const providerUnavailableReason = account.poolType.startsWith("custom:") && !customEnabled
      ? "自定义 Provider 已停用"
      : provider ? "Provider 规则判定该账号不可参与路由" : "未找到对应的 Provider";
    return { ...account, poolLabel: provider?.displayName ?? account.poolType, ...deriveAccountRouteStatus(account, accountWindows, Date.now(), { providerReady, providerUnavailableReason }), quotaWindows: accountWindows };
  }) });
}
