import { Reveal } from "./reveal";

const STEPS = [
  {
    num: "STEP 01",
    title: "部署网关",
    desc: "拉取仓库，运行一键部署脚本完成构建并注册 systemd 服务，网关监听 13600 端口。",
    cmd: "git clone https://github.com/aaravarr/fusion-router.git && cd fusion-router && bash deploy.sh",
  },
  {
    num: "STEP 02",
    title: "导入账号、创建 API Key",
    desc: "打开管理台，在「账号池」页导入各渠道账号凭据；再到「API 密钥」页新建密钥，可按需限定模型白名单。",
    path: "控制台 → 账号池 → 导入账号 / API 密钥 → 新建",
  },
  {
    num: "STEP 03",
    title: "改 base_url",
    desc: "把 coding agent 的 base_url 指向网关，OpenAI 兼容或 Anthropic messages 端点均可，其余配置原样保留。",
    cmd: "export OPENAI_BASE_URL=http://<主机>:13600/v1",
  },
];

export function Steps() {
  return (
    <section className="section" id="flow">
      <div className="container">
        <Reveal className="section-head">
          <span className="eyebrow">GET STARTED</span>
          <h2>三步，把账号池接进来</h2>
          <p>部署网关、导入账号、改一行地址，从零到可用不超过三分钟。</p>
        </Reveal>

        <div className="steps">
          {STEPS.map((s) => (
            <Reveal key={s.num} className="step">
              <span className="step-num">{s.num}</span>
              <div className="step-title">{s.title}</div>
              <div className="step-desc">{s.desc}</div>
              {s.cmd ? (
                <div className="step-cmd">
                  <span className="prompt">$</span>
                  {s.cmd}
                </div>
              ) : (
                <div className="step-path">{s.path}</div>
              )}
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
