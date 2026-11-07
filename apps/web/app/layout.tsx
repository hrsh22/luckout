import { Header } from "@/components/header"
import { SessionProvider } from "@/lib/session"
import type { Metadata } from "next"
import { Inter, Space_Grotesk } from "next/font/google"
import "./globals.css"

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" })
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" })

export const metadata: Metadata = {
  title: "Luckout",
  description: "Checkout, but lucky. Buy the gift cards you already buy, sometimes for much less."
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable}`}>
      <body className="min-h-dvh antialiased">
        <SessionProvider>
          <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-6">
            <Header />
            {children}
          </div>
        </SessionProvider>
      </body>
    </html>
  )
}
