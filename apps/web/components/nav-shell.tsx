"use client"

import { Wordmark } from "@/components/brand"
import { motion } from "motion/react"
import Link from "next/link"
import { usePathname } from "next/navigation"

export interface NavLink {
  href: string
  label: string
}

/**
 * The floating pill bar, the same on the landing page and in the shop, so moving between them
 * feels like one place. The dark pill slides to the page you're on.
 */
export function NavShell({ links, right, home = "/" }: { links: ReadonlyArray<NavLink>; right: React.ReactNode; home?: string }) {
  const path = usePathname()
  const current = (href: string) => !href.includes("#") && (path === href || path.startsWith(`${href}/`))
  const items = (mobile: boolean) =>
    links.map((l) => (
      <Link
        key={l.href}
        href={l.href}
        aria-current={current(l.href) ? "page" : undefined}
        className={`relative shrink-0 rounded-full font-medium transition-colors ${
          mobile ? "px-4 py-1.5 text-sm" : "px-4 py-2"
        } ${current(l.href) ? "text-white" : mobile ? "bg-white/70 text-ink-soft hover:text-ink" : "text-muted hover:text-ink"}`}
      >
        {current(l.href) && (
          <motion.span
            layoutId={mobile ? "nav-current-mobile" : "nav-current"}
            className="absolute inset-0 rounded-full bg-ink"
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
          />
        )}
        <span className="relative">{l.label}</span>
      </Link>
    ))

  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-full focus:bg-white focus:px-4 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-3 z-30 mx-3 mt-3 sm:mx-6 sm:mt-4">
        <nav
          aria-label="Primary"
          className="mx-auto flex max-w-[1240px] items-center gap-2 rounded-full bg-white/85 py-2 pr-2 pl-5 shadow-[0_14px_34px_-24px_rgb(22_18_43/0.45),inset_0_0_0_1px_rgb(255_255_255/0.9)] backdrop-blur-xl sm:gap-5"
        >
          <Wordmark href={home} className="mr-1" />
          <div className="hidden items-center gap-1 md:flex">{items(false)}</div>
          <div className="ml-auto flex min-w-0 items-center gap-2">{right}</div>
        </nav>
      </header>
      <nav aria-label="Sections" className="relative z-10 mx-auto mt-3 flex w-fit max-w-full gap-1 overflow-x-auto px-4 md:hidden">
        {items(true)}
      </nav>
    </>
  )
}
