import type { Metadata, Viewport } from "next"
import localFont from "next/font/local"
import { siteUrl } from "@/lib/site"
import "./globals.css"

const general = localFont({
  variable: "--font-general",
  display: "swap",
  src: [
    { path: "./fonts/GeneralSans-Regular.woff2", weight: "400" },
    { path: "./fonts/GeneralSans-Medium.woff2", weight: "500" },
    { path: "./fonts/GeneralSans-Semibold.woff2", weight: "600" }
  ]
})
const cabinet = localFont({
  variable: "--font-cabinet",
  display: "swap",
  src: [
    { path: "./fonts/CabinetGrotesk-Medium.woff2", weight: "500" },
    { path: "./fonts/CabinetGrotesk-Bold.woff2", weight: "700" },
    { path: "./fonts/CabinetGrotesk-Extrabold.woff2", weight: "800" }
  ]
})

export const metadata: Metadata = {
  // Shared Draw Proof links and Win Cards should point at our domain, not *.vercel.app.
  metadataBase: new URL(siteUrl),
  title: { default: "Luckout: checkout, but lucky", template: "%s | Luckout" },
  description:
    "Gift cards for stores around the world, paid in USDC on NEAR. Pay the price, or add a little for a fair, provable chance at cashback. You always get the card.",
  openGraph: { siteName: "Luckout", type: "website" }
}

export const viewport: Viewport = { themeColor: "#F2F1F8" }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${general.variable} ${cabinet.variable}`}>
      <body className="min-h-dvh overflow-x-clip">{children}</body>
    </html>
  )
}
