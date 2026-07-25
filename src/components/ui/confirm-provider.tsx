"use client"

import * as React from "react"
import { AlertTriangle, Trash2 } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface ConfirmOptions {
  title: string
  description?: React.ReactNode
  confirmText?: string
  cancelText?: string
  destructive?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = React.createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: React.PropsWithChildren) {
  const [request, setRequest] = React.useState<ConfirmOptions | null>(null)
  const resolverRef = React.useRef<((value: boolean) => void) | null>(null)

  const settle = React.useCallback((value: boolean) => {
    resolverRef.current?.(value)
    resolverRef.current = null
    setRequest(null)
  }, [])

  const confirm = React.useCallback<ConfirmFn>((options) => {
    resolverRef.current?.(false)
    setRequest(options)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  React.useEffect(() => () => resolverRef.current?.(false), [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={Boolean(request)} onOpenChange={(open) => { if (!open) settle(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className={request?.destructive ? "bg-destructive/10 text-destructive" : undefined}>
              {request?.destructive ? <Trash2 /> : <AlertTriangle />}
            </AlertDialogMedia>
            <AlertDialogTitle>{request?.title}</AlertDialogTitle>
            {request?.description ? <AlertDialogDescription>{request.description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>{request?.cancelText ?? "取消"}</AlertDialogCancel>
            <AlertDialogAction variant={request?.destructive ? "destructive" : "default"} onClick={() => settle(true)}>
              {request?.confirmText ?? "确认"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const confirm = React.useContext(ConfirmContext)
  if (!confirm) throw new Error("useConfirm 必须在 ConfirmProvider 内使用")
  return confirm
}
