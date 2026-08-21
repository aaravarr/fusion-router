import { LogoMark } from "./logo-mark";

export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div className="footer-brand">
            <a className="brand" href="#top">
              <LogoMark size="sm" />
              <span className="brand-name">Fusion Router</span>
            </a>
            <p>自托管的多模型 AI 账号池网关，聚合多渠道账号，统一协议出口。</p>
          </div>
          <div className="footer-col">
            <h4>产品</h4>
            <a href="#features">功能</a>
            <a href="#flow">流程</a>
            <a href="#models">模型</a>
            <a href="#faq">FAQ</a>
          </div>
          <div className="footer-col">
            <h4>文档</h4>
            <a href="#quickstart">快速开始</a>
            <a href="#models">协议兼容</a>
            <a href="#flow">部署指南</a>
          </div>
          <div className="footer-col">
            <h4>关于</h4>
            <a href="#top">GitHub</a>
            <a href="#top">联系我们</a>
            <a href="#top">许可协议</a>
          </div>
        </div>
        <div className="footer-bottom">
          <span className="copy">© 2025 Fusion Router</span>
          <span className="mono">SELF-HOSTED · MULTI-MODEL GATEWAY</span>
        </div>
      </div>
    </footer>
  );
}
