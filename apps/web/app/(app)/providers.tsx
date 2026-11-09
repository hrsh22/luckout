"use client"

import { SessionProvider, useSession } from "@/lib/session"
import { welcomed } from "@/lib/onboarding"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MotionConfig } from "motion/react"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { Toaster } from "sonner"

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }))
  return (
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="user">
        <SessionProvider>
          <WelcomeGate />
          {children}
        </SessionProvider>
      </MotionConfig>
      <Toaster
        position="bottom-center"
        toastOptions={{ className: "!rounded-2xl !font-sans !text-[15px] !shadow-[0_24px_50px_-30px_rgb(22_18_43/0.6)]" }}
      />
    </QueryClientProvider>
  )
}

/** A new account (signed in, never deposited) starts at Welcome once, then comes back to where it was. */
function WelcomeGate() {
  const { accountId, account } = useSession()
  const path = usePathname()
  const router = useRouter()
  useEffect(() => {
    if (!accountId || account !== null || path === "/welcome" || welcomed(accountId)) return
    router.replace(`/welcome?next=${encodeURIComponent(path)}`)
  }, [accountId, account, path, router])
  return null
}
