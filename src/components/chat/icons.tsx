"use client"

import type { SVGProps } from "react"
import type { ToolVariant } from "@/lib/chat-stream-mapper"

/** 蓝色六边形枢纽 mark（内联自 design-mockups/logo/final/mark.svg） */
export function FusionMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <path d="M32 8.5 L52.4 20.3 L52.4 43.7 L32 55.5 L11.6 43.7 L11.6 20.3 Z" stroke="#2563EB" strokeWidth="6" strokeLinejoin="round" />
      <path d="M32 32 L32 8.5 M32 32 L52.4 43.7 M32 32 L11.6 43.7" stroke="#2563EB" strokeWidth="6" strokeLinecap="round" />
      <circle cx="32" cy="32" r="7" fill="#2563EB" />
      <circle cx="32" cy="8.5" r="4.5" fill="#2563EB" />
      <circle cx="52.4" cy="43.7" r="4.5" fill="#2563EB" />
      <circle cx="11.6" cy="43.7" r="4.5" fill="#2563EB" />
    </svg>
  )
}

type IconProps = SVGProps<SVGSVGElement>

const base = (props: IconProps) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
})

/** 工具变体图标（16px 规格，与设计稿 lucide 路径一致） */
export function ToolVariantIcon({ variant, ...props }: IconProps & { variant: ToolVariant }) {
  switch (variant) {
    case "bash":
      return (
        <svg {...base(props)}>
          <path d="m4 17 6-6-6-6" /><path d="M12 19h8" />
        </svg>
      )
    case "read":
      return (
        <svg {...base(props)}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" />
        </svg>
      )
    case "search":
      return (
        <svg {...base(props)}>
          <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
        </svg>
      )
    case "write":
      return (
        <svg {...base(props)}>
          <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      )
    case "edit":
      return (
        <svg {...base(props)}>
          <path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      )
    case "code":
      return (
        <svg {...base(props)}>
          <path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" />
        </svg>
      )
    default:
      return (
        <svg {...base(props)}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      )
  }
}

