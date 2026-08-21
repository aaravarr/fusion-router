import { Reveal } from "./reveal";

const SPARK_CURVE =
  "M 0.0 46.0 C 3.0 45.0, 12.0 40.3, 18.0 40.0 C 24.0 39.7, 30.0 45.0, 36.0 44.0 C 42.0 43.0, 48.0 35.0, 54.0 34.0 C 60.0 33.0, 66.0 39.0, 72.0 38.0 C 78.0 37.0, 84.0 29.0, 90.0 28.0 C 96.0 27.0, 102.0 33.0, 108.0 32.0 C 114.0 31.0, 120.0 23.0, 126.0 22.0 C 132.0 21.0, 138.0 27.0, 144.0 26.0 C 150.0 25.0, 156.0 17.0, 162.0 16.0 C 168.0 15.0, 174.0 20.7, 180.0 20.0 C 186.0 19.3, 192.0 12.8, 198.0 12.0 C 204.0 11.2, 210.0 15.7, 216.0 15.0 C 222.0 14.3, 231.0 9.2, 234.0 8.0";

export function Bento() {
  return (
    <section className="section" id="features">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">FEATURES</span>
          <h2>账号池网关，需要什么就有什么</h2>
          <p>从账号纳管到请求路由，从用量观测到网络加速，六个能力覆盖日常接入的全部环节。</p>
        </Reveal>

        <div className="bento">
          <Reveal className="cell span-3">
            <div className="c-title">多渠道账号池</div>
            <div className="c-desc">把 OpenCode Go、Kimi Code、Codex、xAI Grok 等上游账号统一纳管，健康度、额度、并发上限集中管理。</div>
            <div className="c-visual chip-row">
              <span className="chip"><span className="dot" />opencode-go</span>
              <span className="chip"><span className="dot" />kimi-code</span>
              <span className="chip"><span className="dot" />codex</span>
              <span className="chip"><span className="dot warn" />xai-grok</span>
              <span className="chip"><span className="dot" />opendesign-go</span>
              <span className="chip ghost">+ 接入新渠道</span>
            </div>
          </Reveal>

          <Reveal className="cell span-3">
            <div className="c-title">智能路由与故障切换</div>
            <div className="c-desc">按模型路由规则分发请求，账号失败时自动切换到下一个可用账号，无感重试，成功率稳定在 99% 以上。</div>
            <div className="c-visual failover">
              <span className="f-node"><b>账号 A</b><span className="role">主 · gpt-4o</span></span>
              <span className="f-arrow">→</span>
              <span className="f-node hot"><b>账号 B</b><span className="role">备 · 已接管</span></span>
              <span className="f-arrow">→</span>
              <span className="f-node"><b>账号 C</b><span className="role">兜底</span></span>
            </div>
          </Reveal>

          <Reveal className="cell span-2">
            <div className="c-title">并发控制与排队</div>
            <div className="c-desc">按账号设置并发上限，超限请求进入队列等待，不丢请求。</div>
            <div className="c-visual gauge">
              <div className="gauge-row"><span>并发占用</span><b>8 / 12</b></div>
              <div className="gauge-bar"><i style={{ width: "67%" }} /></div>
              <span className="gauge-sub">排队中 · 5 requests</span>
            </div>
          </Reveal>

          <Reveal className="cell span-4">
            <div className="c-title">用量可观测</div>
            <div className="c-desc">按渠道、账号统计请求量与耗时，本地准备耗时单独拆出，定位瓶颈更快。</div>
            <div className="c-visual spark-wrap">
              <svg viewBox="0 0 234 56" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#2563EB" stopOpacity="0.18" />
                    <stop offset="1" stopColor="#2563EB" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d={`${SPARK_CURVE} L 234 56 L 0 56 Z`} fill="url(#sparkFill)" />
                <path d={SPARK_CURVE} fill="none" stroke="#2563EB" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
              </svg>
              <div className="spark-stats">
                <span className="s-val">12,847</span>
                <span className="s-lab">今日请求</span>
                <span className="s-val">99.2%</span>
                <span className="s-lab">成功率</span>
              </div>
            </div>
          </Reveal>

          <Reveal className="cell span-4">
            <div className="c-title">镜像组网络加速</div>
            <div className="c-desc">域名级代理、分片与改写规则，就近转发上游，降低首包延迟，弱网下更稳。</div>
            <div className="c-visual kv">
              <div className="kv-row"><span className="k">镜像组</span><span className="v">prod-cn</span></div>
              <div className="chip-row">
                <span className="chip">node-sg.proxy</span>
                <span className="chip">node-hk.proxy</span>
                <span className="chip">node-tokyo.proxy</span>
              </div>
              <div className="tag-group"><span className="tag">域名代理</span><span className="tag">分片</span><span className="tag">改写规则</span></div>
            </div>
          </Reveal>

          <Reveal className="cell span-2">
            <div className="c-title">用户与密钥管理</div>
            <div className="c-desc">每个 API Key 可限制模型白名单，颗粒度到具体模型，安全可控。</div>
            <div className="c-visual kv">
              <div className="kv-row"><span className="k">KEY</span><span className="v">sk-fusion-9f2a••••8b1c</span></div>
              <div className="tag-group"><span className="tag">claude-*</span><span className="tag">gpt-4o</span><span className="tag">kimi-*</span></div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
