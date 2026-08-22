const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:3000';
const TOKEN = 'ODOa63cuHq_p2cRk7j9MuQXCLtSPUw-61WCvYF73DI8';
const OUT_DIR = 'D:/Code/AI/opencode-api/design-mockups/chat/v3';
const storageKey = 'opencode-dashboard-chat-v2';

function mkId() { return Math.random().toString(36).slice(2,10); }

const scenarios = {
  main: {
    sessions: [{ id: 's1', title: '新对话', model: 'gpt-5.6-luna' }],
    currentId: 's1',
    messages: [],
    model: 'gpt-5.6-luna',
    reasoning: 'auto',
    interfaceType: 'chat',
    route: 'auto',
  },
  tools: {
    sessions: [{ id: 's1', title: '排查请求失败排查', model: 'gpt-5.6-luna' }],
    currentId: 's1',
    messages: [
      { id: 'u1', role: 'user', content: '排查这条请求的报错根因，看看是哪个模型池的问题', status: 'complete' },
      {
        id: 'a1',
        role: 'assistant',
        content: '已定位到失败链路，涉及 3 次工具调用，下面是执行详情：\n\n- grep 在上游日志中检索错误堆栈\n- read 读取路由配置确认池映射\n- bash 执行 `pnpm run smoke` 复现',
        reasoning: '需要依次检索日志、读取配置、执行复现命令，验证失败是模型的配额耗尽还是网络抖动',
        reasoningLabel: '思考',
        status: 'complete',
        model: 'gpt-5.6-luna',
        routeLabel: '自动',
        reasoningLabel: 'medium',
        toolCalls: [
          {
            id: 't1',
            name: 'grep',
            variant: 'search',
            title: 'Search',
            summary: 'pattern: exceeded_current_quota_error · 3 处命中',
            state: 'ok',
            arguments: JSON.stringify({ pattern: 'exceeded_current_quota_error', path: 'logs' }),
            output: 'logs/app.log:42: exceeded_current_quota_error\nlogs/app.log:87: exceeded_current_quota_error\nlogs/app.log:102: exceeded_current_quota_error',
            error: undefined,
            renderIntent: 'io',
            startedAt: Date.now()-8000,
            completedAt: Date.now()-6500,
          },
          {
            id: 't2',
            name: 'read_file',
            variant: 'read',
            title: 'Read',
            summary: 'src/server/auth.ts · 42 行',
            state: 'ok',
            arguments: JSON.stringify({ path: 'src/server/auth.ts' }),
            output: '1  import { AuthService } from "./auth"\n2  const svc = new AuthService()\n3  // ... truncated',
            error: undefined,
            renderIntent: 'read',
            readLines: ['import { AuthService } from "./auth"','const svc = new AuthService()','// ... truncated','export const SESSION_COOKIE_NAME = "ocg_session"'],
            startedAt: Date.now()-6000,
            completedAt: Date.now()-4000,
          },
          {
            id: 't3',
            name: 'bash',
            variant: 'bash',
            title: 'Bash',
            summary: 'pnpm run smoke',
            state: 'ok',
            arguments: JSON.stringify({ command: 'pnpm run smoke', description: '复现请求' }),
            output: '$ pnpm run smoke\n✓ 3 passed, 1 failed\nError: exceeded_current_quota_error',
            error: undefined,
            renderIntent: 'io',
            startedAt: Date.now()-3500,
            completedAt: Date.now()-1000,
          },
        ],
      },
    ],
    model: 'gpt-5.6-luna',
    reasoning: 'medium',
    interfaceType: 'chat',
    route: 'auto',
  },
  error: {
    sessions: [{ id: 's1', title: '排查请求失败', model: 'gpt-5.6-luna' }],
    currentId: 's1',
    messages: [
      { id: 'u1', role: 'user', content: '帮我调用 upstream 接口看看为什么 429', status: 'complete' },
      {
        id: 'a1',
        role: 'assistant',
        content: '正在拉取上游响应...',
        reasoning: '尝试调用上游模型接口，复现 429 错误',
        reasoningLabel: '思考',
        status: 'error',
        error: '上游返回 429 exceeded_current_quota_error: 账号配额已耗尽，请切换池或等待重置。已自动重试 2 次均失败。',
        model: 'gpt-5.6-luna',
        routeLabel: '自动',
        toolCalls: [
          {
            id: 't1',
            name: 'bash',
            variant: 'bash',
            title: 'Bash',
            summary: 'curl https://api.kimi.com/coding/v1/models',
            state: 'error',
            arguments: JSON.stringify({ command: 'curl https://api.kimi.com/coding/v1/models' }),
            output: '',
            error: '429 exceeded_current_quota_error',
            renderIntent: 'io',
            startedAt: Date.now()-5000,
            completedAt: Date.now()-1000,
          }
        ],
      },
    ],
    model: 'gpt-5.6-luna',
    reasoning: 'medium',
    interfaceType: 'chat',
    route: 'auto',
  },
  streaming: {
    sessions: [{ id: 's1', title: '对比出口差异', model: 'gpt-5.6-luna' }],
    currentId: 's1',
    messages: [
      { id: 'u1', role: 'user', content: '对比一下 chat 与 responses 入口的行为差异，重点看工具调用链路', status: 'complete' },
      {
        id: 'a1',
        role: 'assistant',
        content: '正在对比两个入口的差异，核心结论：\n\n1. **chat** 入口走 `chat/completions` 兼容层，工具以 `tool_calls` 数组返回；\n2. **responses** 入口走原生 `responses` 协议，工具是 `function_call` 事件流；\n\n下面是实时工具追踪（1 个运行中，2 个已完成）…',
        reasoning: '需要从路由层和协议层的角度，对比 chat 与 responses 的差异，特别是工具调用的序列化方式和错误重试策略。正在整理表格...',
        reasoningLabel: '思考中',
        status: 'streaming',
        model: 'gpt-5.6-luna',
        routeLabel: '自动',
        toolCalls: [
          {
            id: 't1',
            name: 'grep',
            variant: 'search',
            title: 'Search',
            summary: 'pattern: tool_calls · 12 处命中',
            state: 'ok',
            arguments: JSON.stringify({ pattern: 'tool_calls', path: 'src' }),
            output: 'src/lib/chat-stream-mapper.ts: tool_calls',
            error: undefined,
            renderIntent: 'io',
            startedAt: Date.now()-9000,
            completedAt: Date.now()-6000,
          },
          {
            id: 't2',
            name: 'read_file',
            variant: 'read',
            title: 'Read',
            summary: 'src/server/opencode/route-auth.ts',
            state: 'ok',
            arguments: JSON.stringify({ path: 'src/server/opencode/route-auth.ts' }),
            output: '1  export function routeAuth() {\n2    // ...',
            error: undefined,
            renderIntent: 'read',
            readLines: ['export function routeAuth() {','  // ...','}'],
            startedAt: Date.now()-5000,
            completedAt: Date.now()-2000,
          },
          {
            id: 't3',
            name: 'bash',
            variant: 'bash',
            title: 'Bash',
            summary: 'pnpm run build',
            state: 'running',
            arguments: JSON.stringify({ command: 'pnpm run build', description: '验证构建' }),
            output: '$ pnpm run build\nCompiling...',
            error: undefined,
            renderIntent: 'io',
            startedAt: Date.now()-1500,
            completedAt: undefined,
          },
        ],
      },
    ],
    model: 'gpt-5.6-luna',
    reasoning: 'high',
    interfaceType: 'chat',
    route: 'auto',
  },
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  await context.addCookies([{ name: 'ocg_session', value: TOKEN, url: BASE }]);
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60000);

  for (const [name, payload] of Object.entries(scenarios)) {
    console.log('Scenario', name);
    await page.goto(BASE + '/chat', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // ensure chat interface loaded
    await page.waitForSelector('text=Fusion Router', { timeout: 10000 }).catch(()=>{});
    // inject storage
    await page.evaluate((data) => {
      const key = 'opencode-dashboard-chat-v2';
      localStorage.setItem(key, JSON.stringify(data));
    }, payload);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await page.waitForSelector('text=Fusion Router', { timeout: 10000 }).catch(()=>{});
    // wait for composer visible
    await page.waitForSelector('textarea', { timeout: 5000 }).catch(()=>{});
    await page.waitForTimeout(800);
    const out = path.join(OUT_DIR, `impl3-${name}.png`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await page.screenshot({ path: out, fullPage: false });
    console.log('Saved', out);
  }

  await browser.close();
  console.log('Done');
})().catch(e=>{ console.error(e); process.exit(1); });