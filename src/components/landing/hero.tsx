import Link from "next/link";
import { LogoMark } from "./logo-mark";

export function Hero() {
  return (
    <section className="hero">
      <div className="container hero-grid">
        <div className="hero-copy">
          <h1>
            一个网关，聚合你的
            <br />
            <span className="accent">全部模型账号池</span>
          </h1>
          <p className="hero-sub">多渠道账号，统一为一个兼容接口。</p>
          <div className="hero-cta">
            <Link className="btn btn-primary" href="/overview">
              进入控制台
            </Link>
            <a className="btn btn-ghost" href="#quickstart">
              查看文档
            </a>
          </div>
          <div className="hero-spec">
            <b>OPENAI &amp; ANTHROPIC COMPATIBLE</b> · SELF-HOSTED
          </div>
        </div>

        <div className="hero-visual">
          <div className="flow-panel">
            <div className="flow-zone">
              <span className="flow-tag">UPSTREAM · 上游渠道</span>
              <div className="flow-chips">
                <span className="chip">opencode-go</span>
                <span className="chip">kimi-code</span>
                <span className="chip">codex</span>
              </div>
              <div className="flow-chips" style={{ marginTop: 8 }}>
                <span className="chip">xai-grok</span>
                <span className="chip">opendesign-go</span>
              </div>
            </div>

            <svg className="flow-converge" viewBox="0 0 300 56" preserveAspectRatio="none" aria-hidden="true">
              <g stroke="#a1a1aa" strokeWidth="1.75" vectorEffect="non-scaling-stroke">
                <line x1="20" y1="12" x2="150" y2="44" />
                <line x1="85" y1="12" x2="150" y2="44" />
                <line x1="150" y1="12" x2="150" y2="44" />
                <line x1="215" y1="12" x2="150" y2="44" />
                <line x1="280" y1="12" x2="150" y2="44" />
              </g>
              <g fill="#71717a">
                <circle cx="20" cy="12" r="3" />
                <circle cx="85" cy="12" r="3" />
                <circle cx="150" cy="12" r="3" />
                <circle cx="215" cy="12" r="3" />
                <circle cx="280" cy="12" r="3" />
              </g>
              <circle cx="150" cy="44" r="4" fill="#2563EB" />
            </svg>

            <div className="flow-gateway">
              <LogoMark size="sm" />
              <span className="gw-name">Fusion Router</span>
              <span className="gw-sub">账号池网关</span>
            </div>

            <svg className="flow-diverge" viewBox="0 0 300 56" preserveAspectRatio="none" aria-hidden="true">
              <g stroke="#a1a1aa" strokeWidth="1.75" vectorEffect="non-scaling-stroke">
                <line x1="150" y1="12" x2="95" y2="44" />
                <line x1="150" y1="12" x2="205" y2="44" />
              </g>
              <circle cx="150" cy="12" r="4" fill="#2563EB" />
              <g fill="#71717a">
                <circle cx="95" cy="44" r="3" />
                <circle cx="205" cy="44" r="3" />
              </g>
            </svg>

            <div className="flow-zone">
              <span className="flow-tag">EXIT · 统一出口</span>
              <div className="flow-chips">
                <span className="chip big">OpenAI 兼容</span>
                <span className="chip big">Anthropic messages</span>
              </div>
              <span className="flow-note">chat/completions · responses · messages</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
