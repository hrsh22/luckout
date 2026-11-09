import type { Metadata, Viewport } from "next"
import { Archivo } from "next/font/google"
import { siteUrl } from "@/lib/site"
import "./globals.css"

// One family, two voices: normal width for reading, expanded heavy for prices and headlines.
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo" })

export const metadata: Metadata = {
  // Shared Draw Proof links and Win Cards should point at our domain, not *.vercel.app.
  metadataBase: new URL(siteUrl),
  title: { default: "Luckout: checkout, but lucky", template: "%s | Luckout" },
  description:
    "Gift cards, top-ups and eSIMs paid in USDC on NEAR. Pay the price, or add a little for a fair, provable chance to pay less. You always get the card.",
  openGraph: { siteName: "Luckout", type: "website" }
}

export const viewport: Viewport = { themeColor: "#13161D" }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body className="bg-background text-foreground min-h-dvh antialiased">{children}</body>
    </html>
  )
}
