import { Reveal } from "./reveal";

const STEPS = [
  {
    num: "STEP 01",
    title: "导入账号",
    desc: "把各渠道的账号凭据导入网关，自动识别健康度与额度。",
    cmd: "fusion account import --kimi-code",
  },
  {
    num: "STEP 02",
    title: "创建 API Key",
    desc: "为你的 coding agent 生成密钥，按需限定模型白名单。",
    cmd: 'fusion key create --model "claude-*,gpt-*"',
  },
  {
    num: "STEP 03",
    title: "改 base_url",
    desc: "把 agent 的端点指向网关，其余配置原样保留。",
    cmd: "export BASE_URL=http://fusion.local:8000/v1",
  },
];

export function Steps() {
  return (
    <section className="section" id="flow">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">GET STARTED</span>
          <h2>三步，把账号池接进来</h2>
          <p>导入账号、创建密钥、改一行地址，从零到可用不超过三分钟。</p>
        </Reveal>

        <div className="steps">
          {STEPS.map((s) => (
            <Reveal key={s.num} className="step">
              <span className="step-num">{s.num}</span>
              <div className="step-title">{s.title}</div>
              <div className="step-desc">{s.desc}</div>
              <div className="step-cmd">
                <span className="prompt">$</span>
                {s.cmd}
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
