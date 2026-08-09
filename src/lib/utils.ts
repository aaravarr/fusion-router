import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text || typeof document === "undefined") return false
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to legacy path
  }
  let textarea: HTMLTextAreaElement | null = null
  try {
    textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.setAttribute("aria-hidden", "true")
    // clipboard.js 式兜底：不用 opacity:0（部分浏览器/iOS 会拒绝复制不可见元素），
    // 改为移出视口；且挂到当前打开的 dialog 内，避免 Radix focus trap 把焦点抢回去
    // 导致选区丢失、execCommand("copy") 静默失败（HTTP 非安全上下文只有这条路）。
    textarea.style.position = "fixed"
    textarea.style.top = "0"
    textarea.style.left = "-9999px"
    textarea.style.width = "2em"
    textarea.style.height = "2em"
    textarea.style.padding = "0"
    textarea.style.border = "0"
    textarea.style.fontSize = "16px"
    const container = document.querySelector('[role="dialog"]') ?? document.body
    container.appendChild(textarea)
    textarea.focus({ preventScroll: true })
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    const ok = document.execCommand("copy")
    return ok
  } catch {
    return false
  } finally {
    textarea?.remove()
  }
}
