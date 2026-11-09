import { SiteFooter, SiteHeader } from "@/components/site-chrome"

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-clip">
      <SiteHeader />
      {children}
      <SiteFooter />
    </div>
  )
}
