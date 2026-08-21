"use client";

import Link from "next/link";
import { useEffect } from "react";
import { LogoMark } from "./logo-mark";

export function Nav() {
  useEffect(() => {
    const nav = document.getElementById("site-nav");
    if (!nav) return;

    const onScroll = () => {
      if (window.scrollY > 8) nav.classList.add("scrolled");
      else nav.classList.remove("scrolled");
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className="nav" id="site-nav">
      <div className="container nav-inner">
        <a className="brand" href="#top" aria-label="Fusion Router 首页">
          <LogoMark />
          <span className="brand-name">Fusion Router</span>
        </a>
        <nav className="nav-links" aria-label="页面导航">
          <a href="#features">功能</a>
          <a href="#flow">流程</a>
          <a href="#models">模型</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div className="nav-right">
          <Link
            href="/overview"
            style={{ fontSize: 14.5, fontWeight: 600, color: "var(--landing-accent)", padding: "8px 4px" }}
          >
            控制台 →
          </Link>
        </div>
      </div>
    </header>
  );
}
