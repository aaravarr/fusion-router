"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { CheckIcon, MinusIcon } from "lucide-react"

import { cn } from "@/lib/utils"

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-input bg-background text-primary-foreground shadow-xs outline-none transition-[background-color,border-color,box-shadow,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-foreground/35 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:scale-[0.94] disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary before:absolute before:-inset-3 before:content-['']",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-items-center transition-opacity duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]">
        {props.checked === "indeterminate" ? <MinusIcon className="size-3" /> : <CheckIcon className="size-3" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }