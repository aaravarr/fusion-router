import { LogoMark } from "./logo-mark";
import { Reveal } from "./reveal";

const AREA_CURVE =
  "M 0.0 150.0 C 4.5 149.0, 18.2 144.0, 27.0 144.0 C 35.8 144.0, 44.2 153.7, 53.0 150.0 C 61.8 146.3, 71.0 130.7, 80.0 122.0 C 89.0 113.3, 98.2 100.7, 107.0 98.0 C 115.8 95.3, 124.2 109.0, 133.0 106.0 C 141.8 103.0, 151.0 86.7, 160.0 80.0 C 169.0 73.3, 178.2 65.0, 187.0 66.0 C 195.8 67.0, 204.2 87.3, 213.0 86.0 C 221.8 84.7, 231.0 61.7, 240.0 58.0 C 249.0 54.3, 258.2 66.7, 267.0 64.0 C 275.8 61.3, 284.2 43.7, 293.0 42.0 C 301.8 40.3, 311.0 55.0, 320.0 54.0 C 329.0 53.0, 338.2 37.3, 347.0 36.0 C 355.8 34.7, 364.2 47.0, 373.0 46.0 C 381.8 45.0, 391.0 31.3, 400.0 30.0 C 409.0 28.7, 418.2 39.0, 427.0 38.0 C 435.8 37.0, 444.2 25.0, 453.0 24.0 C 461.8 23.0, 471.0 32.7, 480.0 32.0 C 489.0 31.3, 498.2 20.7, 507.0 20.0 C 515.8 19.3, 524.2 27.7, 533.0 28.0 C 541.8 28.3, 551.0 24.0, 560.0 22.0 C 569.0 20.0, 578.2 15.3, 587.0 16.0 C 595.8 16.7, 604.2 26.3, 613.0 26.0 C 621.8 25.7, 635.5 16.0, 640.0 14.0";

export function MockPreview() {
  return (
    <section className="section mock-section" id="overview">
      <div className="container">
        <Reveal className="section-head">
          <h2>管理台，账号池尽在掌握</h2>
          <p>账号运行状态一目了然。</p>
        </Reveal>

        <Reveal className="mock-scroll">
          <div className="browser">
            <div className="browser-bar">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="url">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                  <rect x="4" y="7" width="8" height="6" rx="1.5" />
                  <path d="M6 7V5a2 2 0 0 1 4 0V7" />
                </svg>
                https://fusion.local/overview
              </span>
              <span className="spacer" />
            </div>

            <div className="console">
              <aside className="sidebar">
                <div className="side-logo">
                  <LogoMark size="sm" />
                  <span className="t">Fusion Router</span>
                </div>
                <nav className="side-nav">
                  <a className="active">
                    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2.6" y="2.6" width="4.5" height="4.5" rx="1" />
                      <rect x="8.9" y="2.6" width="4.5" height="4.5" rx="1" />
                      <rect x="2.6" y="8.9" width="4.5" height="4.5" rx="1" />
                      <rect x="8.9" y="8.9" width="4.5" height="4.5" rx="1" />
                    </svg>
                    概览
                  </a>
                  <a>
                    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M3.2 13V8.5M8 13V4M12.8 13V6.5" />
                    </svg>
                    用量
                  </a>
                  <a>
                    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <ellipse cx="8" cy="4.2" rx="5.4" ry="2.2" />
                      <path d="M2.6 4.2V11.8C2.6 13 5 14.4 8 14.4C11 14.4 13.4 13 13.4 11.8V4.2" />
                      <path d="M2.6 8C2.6 9.2 5 10.2 8 10.2C11 10.2 13.4 9.2 13.4 8" />
                    </svg>
                    账号池
                  </a>
                  <a>
                    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.6 8H4.6L6.6 4L9.6 12L11.6 8H14.4" />
                    </svg>
                    请求
                  </a>
                  <a>
                    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <circle cx="8" cy="5.4" r="2.6" />
                      <path d="M3.2 13.6C3.2 10.8 5.4 9.6 8 9.6C10.6 9.6 12.8 10.8 12.8 13.6" />
                    </svg>
                    用户
                  </a>
                  <a>
                    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M2.5 4H13.5M2.5 8H13.5M2.5 12H13.5" />
                      <circle cx="5.5" cy="4" r="1.3" fill="currentColor" stroke="none" />
                      <circle cx="10.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
                      <circle cx="7.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
                    </svg>
                    设置
                  </a>
                </nav>
                <div className="side-foot">
                  <span className="sf">
                    <i />
                    GATEWAY · RUNNING
                  </span>
                </div>
              </aside>

              <div className="console-main">
                <div className="console-top">
                  <span className="crumb">
                    概览 <span>/ 今日</span>
                  </span>
                  <div className="top-actions">
                    <span className="search">搜索账号 / 请求…</span>
                    <span className="btn btn-primary btn-sm" style={{ padding: "7px 13px" }}>
                      新建 API Key
                    </span>
                    <span className="avatar">F</span>
                  </div>
                </div>

                <div className="console-body">
                  <div className="kpis">
                    <div className="kpi">
                      <div className="k-label">今日请求</div>
                      <div className="k-value">12,847</div>
                      <div className="k-delta">+18.2% 较昨日</div>
                    </div>
                    <div className="kpi">
                      <div className="k-label">成功率</div>
                      <div className="k-value">99.2%</div>
                      <div className="k-delta">稳定</div>
                    </div>
                    <div className="kpi">
                      <div className="k-label">活跃账号</div>
                      <div className="k-value">23</div>
                      <div className="k-delta">5 个账号待命</div>
                    </div>
                    <div className="kpi">
                      <div className="k-label">接入渠道</div>
                      <div className="k-value">5</div>
                      <div className="k-delta warn">1 渠道额度告警</div>
                    </div>
                  </div>

                  <div className="panels">
                    <div className="panel">
                      <div className="panel-head">
                        <span className="panel-title">请求量 · 近 24 小时</span>
                        <span className="panel-meta">QPS PEAK 42</span>
                      </div>
                      <div className="chart-wrap">
                        <svg viewBox="0 0 640 200" preserveAspectRatio="none" aria-hidden="true">
                          <defs>
                            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0" stopColor="#2563EB" stopOpacity="0.16" />
                              <stop offset="1" stopColor="#2563EB" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <g stroke="#e4e4e7" strokeWidth="1" vectorEffect="non-scaling-stroke">
                            <line x1="0" y1="40" x2="640" y2="40" />
                            <line x1="0" y1="80" x2="640" y2="80" />
                            <line x1="0" y1="120" x2="640" y2="120" />
                            <line x1="0" y1="160" x2="640" y2="160" />
                          </g>
                          <path d={`${AREA_CURVE} L 640 188 L 0 188 Z`} fill="url(#areaFill)" />
                          <path d={AREA_CURVE} fill="none" stroke="#2563EB" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="chart-axis">
                        <span>00:00</span>
                        <span>06:00</span>
                        <span>12:00</span>
                        <span>18:00</span>
                        <span>24:00</span>
                      </div>
                    </div>

                    <div className="panel">
                      <div className="panel-head">
                        <span className="panel-title">账号池健康</span>
                        <span className="panel-meta">21 / 23</span>
                      </div>
                      <div className="acct-list">
                        <div className="acct">
                          <span className="dot ok" />
                          <span className="name">opencode-go</span>
                          <span className="bar">
                            <i className="ok" style={{ width: "82%" }} />
                          </span>
                          <span className="pct">82%</span>
                        </div>
                        <div className="acct">
                          <span className="dot ok" />
                          <span className="name">kimi-code</span>
                          <span className="bar">
                            <i className="ok" style={{ width: "64%" }} />
                          </span>
                          <span className="pct">64%</span>
                        </div>
                        <div className="acct">
                          <span className="dot ok" />
                          <span className="name">codex</span>
                          <span className="bar">
                            <i className="ok" style={{ width: "45%" }} />
                          </span>
                          <span className="pct">45%</span>
                        </div>
                        <div className="acct">
                          <span className="dot warn" />
                          <span className="name">xai-grok</span>
                          <span className="bar">
                            <i className="warn" style={{ width: "12%" }} />
                          </span>
                          <span className="pct">12% · 限流中</span>
                        </div>
                        <div className="acct">
                          <span className="dot ok" />
                          <span className="name">opendesign-go</span>
                          <span className="bar">
                            <i className="ok" style={{ width: "91%" }} />
                          </span>
                          <span className="pct">91%</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
