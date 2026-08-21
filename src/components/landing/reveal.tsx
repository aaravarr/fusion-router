"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

export function Reveal({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-visible");
      return;
    }

    let timer: number | undefined;
    let io: IntersectionObserver | undefined;

    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              el.classList.add("is-visible");
              io?.unobserve(el);
            }
          });
        },
        { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
      );
      io.observe(el);
      // 600ms fallback: force reveal so content can never stay hidden.
      timer = window.setTimeout(() => el.classList.add("is-visible"), 600);
    } else {
      el.classList.add("is-visible");
    }

    return () => {
      io?.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  return (
    <div ref={ref} style={style} className={className ? `reveal ${className}` : "reveal"}>
      {children}
    </div>
  );
}
