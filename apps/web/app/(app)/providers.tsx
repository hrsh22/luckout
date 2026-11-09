"use client"

import { SessionProvider, useSession } from "@/lib/session"
import { Mark } from "@/components/brand"
import { Welcome } from "@/components/welcome"
import { markWelcomed, welcomed } from "@/lib/onboarding"
import { Dialog } from "@base-ui/react/dialog"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MotionConfig } from "motion/react"
import { usePathname } from "next/navigation"
import { Suspense, useEffect, useRef, useState } from "react"
import { Toaster } from "sonner"

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }))
  return (
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="user">
        <SessionProvider>
          {children}
          <Suspense>
            <WelcomeGate />
          </Suspense>
        </SessionProvider>
      </MotionConfig>
      <Toaster
        position="bottom-center"
        toastOptions={{ className: "!rounded-2xl !font-sans !text-[15px] !shadow-[0_24px_50px_-30px_rgb(22_18_43/0.6)]" }}
      />
    </QueryClientProvider>
  )
}

/**
 * A new account (signed in, never deposited) gets Welcome once, over the page it signed in on.
 * No redirect: closing it leaves the customer exactly where they were.
 */
function WelcomeGate() {
  const { accountId, account } = useSession()
  const path = usePathname()
  const [open, setOpen] = useState(false)
  // Focus lands on the content, so opening doesn't highlight "Skip for now".
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (accountId && account === null && path !== "/welcome" && !welcomed(accountId)) setOpen(true)
    if (!accountId) setOpen(false)
  }, [accountId, account, path])
  const close = () => {
    if (accountId) markWelcomed(accountId)
    setOpen(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[6px] transition-opacity duration-300 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup initialFocus={content} className="fixed inset-0 z-50 overflow-y-auto bg-canvas outline-none transition-[opacity,translate] duration-300 ease-[cubic-bezier(.2,.9,.25,1)] data-[ending-style]:translate-y-6 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-6 data-[starting-style]:opacity-0 sm:inset-4 sm:rounded-[2.25rem] sm:shadow-pop">
          <Dialog.Title className="sr-only">Welcome to Luckout</Dialog.Title>
          <div className="sticky top-0 z-10 flex items-center justify-between bg-canvas/85 px-6 py-4 backdrop-blur sm:px-10">
            <Mark className="size-8" />
            <Dialog.Close className="h-10 rounded-full px-4 text-sm font-semibold text-muted transition-colors hover:bg-white hover:text-ink">
              Skip for now
            </Dialog.Close>
          </div>
          <div ref={content} tabIndex={-1} className="px-6 pt-4 pb-12 outline-none sm:px-10">
            <Welcome onDone={close} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
