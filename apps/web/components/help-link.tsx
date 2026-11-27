import Link from "next/link"

/**
 * A link from the app into the docs. It opens a new tab, so reading it never costs a half-finished purchase, a
 * Welcome step or an open sheet. lib/docs.test.ts checks every such link's page and #section exist.
 */
export const HelpLink = ({ href, children }: { href: `/docs${string}`; children: React.ReactNode }) => (
  <Link href={href} target="_blank" className="font-semibold underline underline-offset-4">{children}</Link>
)
