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
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  )
}
