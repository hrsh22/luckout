import { AppNav } from "@/components/app-nav"
import { SiteFooter } from "@/components/site-chrome"
import { AppProviders } from "./providers"

// Wallet code and the API client load only in the app, never on the landing or proof pages.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders>
      <div className="relative flex min-h-dvh flex-col">
        <div className="blob top-0 -right-40 size-[420px] bg-[#CDBEFF] opacity-50" aria-hidden="true" />
        <div className="blob top-[480px] -left-48 size-[380px] bg-[#FFD9C2] opacity-50" aria-hidden="true" />
        <AppNav />
        <main id="main" className="relative mx-auto flex w-full max-w-[1240px] flex-1 flex-col px-4 pt-8 pb-16 sm:px-10 sm:pt-10">
          {children}
        </main>
        <SiteFooter compact />
      </div>
    </AppProviders>
  )
}
