import { Reveal } from "./reveal";

export function CodeDiff() {
  return (
    <section className="section code-section" id="quickstart">
      <div className="container code-grid">
        <Reveal>
          <h2 style={{ fontSize: 34, lineHeight: 1.2, letterSpacing: "-0.02em", fontWeight: 650 }}>
            改一行 <span className="mono" style={{ color: "var(--landing-accent)" }}>base_url</span>，接入所有模型
          </h2>
          <p style={{ color: "var(--landing-text-3)", marginTop: 14, fontSize: 16, maxWidth: 460 }}>
            把原本分散的各家端点，换成网关的一个地址。OpenAI 兼容与 Anthropic messages 双协议出口，Claude Code、Cursor、opencode 直接可用。
          </p>
          <div className="code-note">OPENAI &amp; ANTHROPIC COMPATIBLE · ZERO REWRITE</div>
        </Reveal>

        <Reveal>
          <div className="code-card">
            <div className="code-bar">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="code-file">config.ts</span>
            </div>
            <div className="code-body">
              <div className="code-line rem">
                <span className="mark">-</span>
                <span className="cx">OPENAI_BASE_URL = "https://api.openai.com/v1"</span>
              </div>
              <div className="code-line rem">
                <span className="mark">-</span>
                <span className="cx">ANTHROPIC_BASE_URL = "https://api.anthropic.com"</span>
              </div>
              <div className="code-line add">
                <span className="mark">+</span>
                <span className="cx">BASE_URL = "http://fusion.local:13600/v1"</span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
