import { fetch as undiciFetch, Agent, type Dispatcher } from "undici";
import { getProxyDispatcher, resolveMirrorUrl } from "@/server/api-fetch";

export const runtime = "nodejs";
// 路由级 ISR：5 分钟内复用同一份 GitHub 响应，避免每次请求都打 GitHub API。
export const revalidate = 300;

const REPO = "aaravarr/opencode-api";
const ASSET_NAME = "opencode-go-connector.zip";
const FALLBACK_DOWNLOAD = `https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}`;
const FALLBACK_RELEASE = `https://github.com/${REPO}/releases/latest`;

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string | null;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

// API 请求直连 api.github.com；部署环境如需系统代理，可通过 https_proxy/http_proxy 环境变量配置。
// dispatcher 走进程级缓存：代理复用 api-fetch 的共享 ProxyAgent 池（bodyTimeout: 0），
// 无代理时共享一个直连 Agent，均避免每请求新建连接池。
let directAgent: Agent | undefined;
function dispatcher(): Dispatcher {
  const proxy =
    process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY;
  if (proxy) return getProxyDispatcher(proxy);
  return (directAgent ??= new Agent());
}

export async function GET(): Promise<Response> {
  const api = `https://api.github.com/repos/${REPO}/releases/latest`;
  try {
    const response = await undiciFetch(api, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "opencode-api-extension-check",
      },
      signal: AbortSignal.timeout(8000),
      dispatcher: dispatcher(),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    const data = (await response.json()) as GitHubRelease;
    const tag = String(data.tag_name || "");
    const version = tag.replace(/^v/i, "");
    const asset = data.assets?.find((a) => a.name === ASSET_NAME);
    return Response.json({
      version: version || null,
      // 域名镜像映射里若配置了 github.com → 镜像站，则出站链接自动走镜像。
      downloadUrl: resolveMirrorUrl(asset?.browser_download_url || FALLBACK_DOWNLOAD),
      releaseUrl: resolveMirrorUrl(data.html_url || FALLBACK_RELEASE),
      notes: data.body || null,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    // GitHub 不可达（本地开发无外网、或 API 限流）时回退到固定下载地址；
    // version 为 null 表示无法确定最新版本，调用方可据此引导手动查看。
    return Response.json({
      version: null,
      downloadUrl: resolveMirrorUrl(FALLBACK_DOWNLOAD),
      releaseUrl: resolveMirrorUrl(FALLBACK_RELEASE),
      notes: null,
      checkedAt: new Date().toISOString(),
    });
  }
}
