import { Reveal } from "./reveal";

const ROWS = [
  { name: "OpenCode Go", tag: "opencode.ai", chat: true, responses: false, messages: true },
  { name: "Kimi Code", tag: "api.kimi.com", chat: true, responses: false, messages: true },
  { name: "OpenAI Codex", tag: "chatgpt.com", chat: false, responses: true, messages: false },
  { name: "xAI Grok", tag: "grok.com", chat: true, responses: true, messages: false },
  { name: "OpenDesign Go", tag: "amr-link.open-design.ai", chat: true, responses: false, messages: true },
];

function Mark({ on }: { on: boolean }) {
  return on ? <td className="yes">●</td> : <td className="no">○</td>;
}

export function Matrix() {
  return (
    <section className="section matrix-section" id="models">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">COMPATIBILITY</span>
          <h2>渠道 × 协议，一张表看清</h2>
          <p>出口统一 OpenAI 兼容与 Anthropic messages，上游协议差异由网关抹平。</p>
        </Reveal>

        <Reveal className="matrix-wrap">
          <table className="matrix-table">
            <thead>
              <tr>
                <th>渠道</th>
                <th>chat/completions</th>
                <th>responses</th>
                <th>messages</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.name}>
                  <td>
                    <span className="ch-name">{r.name}</span>
                    <span className="ch-tag">{r.tag}</span>
                  </td>
                  <Mark on={r.chat} />
                  <Mark on={r.responses} />
                  <Mark on={r.messages} />
                </tr>
              ))}
            </tbody>
          </table>
        </Reveal>

        <Reveal className="legend">
          <span className="lg"><span className="mark yes">●</span> 原生支持</span>
          <span className="lg"><span className="mark no">○</span> 网关自动转换协议，调用方无感知</span>
        </Reveal>
      </div>
    </section>
  );
}
