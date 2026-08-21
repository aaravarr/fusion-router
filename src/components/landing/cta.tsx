import Link from "next/link";
import { Reveal } from "./reveal";

export function Cta() {
  return (
    <section className="section" id="cta" style={{ paddingTop: 0 }}>
      <div className="container">
        <Reveal className="cta-band">
          <div>
            <h2>现在就把你的账号池接进来</h2>
            <p>一个网关，聚合全部模型账号。自托管，改一行 base_url 即可接入。</p>
            <Link className="btn" href="/overview">
              进入控制台
            </Link>
            <span className="cta-mono">SELF-HOSTED · OPENAI &amp; ANTHROPIC COMPATIBLE</span>
          </div>
          <div className="cta-term">
            <span className="p">$</span> docker run -d -p 13600:13600 fusion-router
            <br />
            <span className="p"># 或</span>
            <br />
            <span className="p">$</span> cd ~/fusion-router && bash deploy.sh
          </div>
        </Reveal>
      </div>
    </section>
  );
}
