"use client"

import { Dialog } from "@base-ui/react/dialog"
import { X } from "lucide-react"

/**
 * A dialog that rises from the bottom on phones and sits centred on larger screens. Used wherever
 * the next step shouldn't take you away from the page you're on: adding funds, withdrawing, signing in.
 */
export function Sheet({ open, onOpenChange, title, description, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/35 backdrop-blur-[6px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed inset-x-0 bottom-0 z-50 scroll-soft max-h-[92dvh] overflow-y-auto rounded-t-[2rem] bg-white p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-pop outline-none transition-[translate,opacity] duration-300 ease-[cubic-bezier(.2,.9,.25,1)] data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[min(92vw,480px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[2rem] sm:p-7 sm:data-[ending-style]:translate-y-[-46%] sm:data-[ending-style]:opacity-0 sm:data-[starting-style]:translate-y-[-46%] sm:data-[starting-style]:opacity-0">
          <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-line sm:hidden" aria-hidden="true" />
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="font-display text-[28px] leading-tight font-extrabold">{title}</Dialog.Title>
              {description && <Dialog.Description className="mt-1 text-ink-soft">{description}</Dialog.Description>}
            </div>
            <Dialog.Close className="-mt-1 -mr-2 grid size-10 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-soft hover:text-ink" aria-label="Close">
              <X size={20} />
            </Dialog.Close>
          </div>
          <div className="mt-5">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
