"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Reveal } from "./reveal";

const ITEMS: { q: string; a: ReactNode }[] = [
  {
    q: "Fusion Router 收费吗？",
    a: "Fusion Router 本身是自托管软件，可免费部署在你自己的服务器上。成本主要来自你使用的上游渠道账号额度，网关本身不抽成。",
  },
  {
    q: "账号数据安全吗？",
    a: "完全自托管，代码与数据都在你自己的机器上，不经过任何第三方服务器。凭据本地加密存储，API Key 可按模型白名单做最小权限隔离。",
  },
  {
    q: "支持哪些模型和渠道？",
    a: "当前聚合 OpenCode Go、Kimi Code、OpenAI Codex、xAI Grok、OpenDesign Go 等渠道。上游能力以实测为准，出口统一为 OpenAI 兼容与 Anthropic messages 双协议。",
  },
  {
    q: "从现有配置迁移复杂吗？",
    a: (
      <>
        不复杂。导入账号、创建 API Key 之后，只需把 agent 的 <span className="mono">base_url</span>{" "}
        指向网关地址即可，其余请求格式与代码无需改动。
      </>
    ),
  },
  {
    q: "自部署需要什么环境？",
    a: "一台可访问上游渠道的服务器即可，支持 Docker 一键部署。内存占用低，个人小团队的一台轻量云主机即可稳定运行。",
  },
  {
    q: "和普通代理中转有什么区别？",
    a: "普通代理只是转发，Fusion Router 额外提供账号池健康管理、按模型智能路由、失败自动切换、并发排队、用量看板与密钥白名单，是一层完整的账号池网关。",
  },
];

export function Faq() {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const details = Array.from(list.querySelectorAll<HTMLDetailsElement>("details.faq"));
    const onToggle = (e: Event) => {
      const current = e.currentTarget as HTMLDetailsElement;
      if (current.open) {
        details.forEach((d) => {
          if (d !== current) d.open = false;
        });
      }
    };
    details.forEach((d) => d.addEventListener("toggle", onToggle));
    return () => details.forEach((d) => d.removeEventListener("toggle", onToggle));
  }, []);

  return (
    <section className="section" id="faq">
      <div className="container">
        <Reveal className="section-head" style={{ marginBottom: 40 }}>
          <h2>常见问题</h2>
        </Reveal>

        <Reveal className="faq-list">
          <div ref={listRef}>
            {ITEMS.map((item, i) => (
              <details className="faq" key={item.q} open={i === 0}>
                <summary>
                  {item.q}
                  <span className="chev" />
                </summary>
                <div className="faq-body">{item.a}</div>
              </details>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}
