import { docHref, DOCS } from "@/lib/docs"
import { siteUrl } from "@/lib/site"

// The docs for AI search and outside agents (llmstxt.org): one line per page, from the same list as the sitemap.
export const dynamic = "force-static"

export function GET() {
  const sections = [...new Set(DOCS.map((d) => d.section))]
  const body = [
    "# Luckout",
    "",
    "> Buy gift cards for thousands of brands with USDC, at their price or with a little extra up front for a fair chance at cashback. You always get the card.",
    "",
    ...sections.flatMap((s) => [`## ${s}`, "", ...DOCS.filter((d) => d.section === s).map((d) => `- [${d.title}](${siteUrl}${docHref(d)}): ${d.description}`), ""])
  ].join("\n")
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
}
