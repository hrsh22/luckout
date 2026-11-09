import { AppHeader } from "@/components/app-header"
import { SessionProvider } from "@/lib/session"
import Link from "next/link"

// Wallet code and the API client load only in the app, never on the landing or proof pages.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <div className="flex min-h-dvh flex-col">
        <AppHeader />
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8 sm:px-6">{children}</div>
        <footer className="text-muted-foreground mx-auto flex w-full max-w-6xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm sm:px-6">
          <Link href="/" className="hover:text-foreground">About Luckout</Link>
          <Link href="/fair" className="hover:text-foreground">Fairness</Link>
        </footer>
      </div>
    </SessionProvider>
  )
}
