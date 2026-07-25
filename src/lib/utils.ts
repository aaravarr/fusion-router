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
    textarea.style.position = "fixed"
    textarea.style.top = "0"
    textarea.style.left = "0"
    textarea.style.width = "1px"
    textarea.style.height = "1px"
    textarea.style.padding = "0"
    textarea.style.border = "0"
    textarea.style.fontSize = "16px"
    textarea.style.opacity = "0"
    document.body.appendChild(textarea)
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
