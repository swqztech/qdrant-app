import { toast as sonner } from 'sonner'

function text(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

type IdOpt = { id?: string | number }

export const toast = {
  success: (message: string, opts?: IdOpt) => sonner.success(message, opts),
  error: (err: unknown, opts?: IdOpt) => sonner.error(text(err), opts),
  info: (message: string, opts?: IdOpt) => sonner.message(message, opts),
  warning: (message: string, opts?: IdOpt) => sonner.warning(message, opts),
  loading: (message: string, id?: string | number) =>
    sonner.loading(message, id === undefined ? undefined : { id }),
  dismiss: (id?: string | number) => sonner.dismiss(id),
}

export const IO_TOAST = 'qdrant-io'
