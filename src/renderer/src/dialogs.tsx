import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

type ConfirmRequest = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

type DialogApi = {
  confirm: (opts: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>
}

const DialogContext = createContext<DialogApi | null>(null)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ConfirmRequest | null>(null)

  const api = useMemo<DialogApi>(
    () => ({
      confirm: (opts) =>
        new Promise((resolve) => {
          setReq({ ...opts, resolve })
        }),
    }),
    [],
  )

  const cancel = () => {
    if (!req) return
    req.resolve(false)
    setReq(null)
  }

  const ok = () => {
    if (!req) return
    req.resolve(true)
    setReq(null)
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {req && (
        <div className="modal-backdrop" role="presentation" onClick={cancel}>
          <div
            className="modal modal-sm"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2 id="confirm-dialog-title">{req.title}</h2>
              <button type="button" className="ghost" onClick={cancel}>
                {req.cancelLabel ?? '取消'}
              </button>
            </div>
            <div className="modal-body">
              <p className="import-summary" style={{ whiteSpace: 'pre-wrap' }}>
                {req.message}
              </p>
              <div className="import-actions">
                <button type="button" className="ghost" onClick={cancel}>
                  {req.cancelLabel ?? '取消'}
                </button>
                <button
                  type="button"
                  className={req.danger ? 'danger' : undefined}
                  onClick={ok}
                >
                  {req.confirmLabel ?? '确定'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialog 必须在 DialogProvider 内使用')
  return ctx
}
