import { childrenOf, type Doc, docFile, docHref, DOCS, parentOf } from "@/lib/docs"
import { ArrowRight, ChevronDown } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"

export const docMetadata = (d: Doc): Metadata => ({
  title: d.title,
  description: d.description,
  alternates: { canonical: docHref(d) },
  // Replaces the root layout's openGraph rather than merging with it, so siteName is repeated.
  openGraph: { title: d.title, description: d.description, url: docHref(d), siteName: "Luckout", type: "article" }
})

const SECTIONS = [...new Set(DOCS.map((d) => d.section))]

/** One docs page: the sidebar (a folding menu on phones), the page's MDX, its subpages, then previous and next. */
export async function DocView({ doc }: { doc: Doc }) {
  const { default: Content } = await import(`@/content/docs/${docFile(doc)}.mdx`)
  const i = DOCS.indexOf(doc)
  const [prev, next] = [DOCS[i - 1], DOCS[i + 1]]
  const parent = parentOf(doc)
  const children = childrenOf(doc)

  return (
    <main id="main" className="relative mx-auto grid w-full max-w-[1240px] gap-8 px-6 pt-8 sm:px-10 lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-16 lg:pt-14">
      <div className="blob top-0 -right-40 size-[380px] bg-[#CDBEFF] opacity-50" aria-hidden="true" />

      <nav aria-label="Docs" className="relative lg:hidden">
        <details className="group card">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 font-semibold [&::-webkit-details-marker]:hidden">
            All docs pages
            <ChevronDown size={18} className="shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="px-2 pb-4"><Pages current={doc} /></div>
        </details>
      </nav>
      <nav aria-label="Docs" className="sticky top-28 hidden max-h-[calc(100dvh-8rem)] self-start overflow-y-auto pb-6 lg:block">
        <Pages current={doc} />
      </nav>

      <article className="relative max-w-[68ch] min-w-0 text-[17px] leading-relaxed text-ink-soft">
        {parent
          ? <Link href={docHref(parent)} className="text-sm font-semibold text-muted hover:text-ink">{parent.title}</Link>
          : <p className="text-sm font-semibold text-muted">{doc.section}</p>}
        <h1 className="font-display mt-2 text-[44px] leading-[0.95] font-extrabold tracking-[-0.03em] text-ink sm:text-[64px]">{doc.title}</h1>
        <div className="mt-6 [&>p:first-child]:text-lg">
          <Content />
        </div>
        {children.length > 0 && (
          <section aria-labelledby="in-this-part" className="mt-14">
            <h2 id="in-this-part" className="font-display text-[30px] leading-tight font-extrabold tracking-[-0.02em] text-ink sm:text-[34px]">In this part</h2>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {children.map((c) => (
                <li key={c.slug} className="flex">
                  <Link href={docHref(c)} className="card group flex flex-1 flex-col p-5 transition-shadow hover:shadow-float">
                    <span className="flex items-center justify-between gap-3 font-semibold text-ink">
                      {c.title}<ArrowRight size={18} className="shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                    </span>
                    <span className="mt-1 text-[15px] leading-snug">{c.description}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        <nav aria-label="Previous and next" className="mt-16 grid gap-3 sm:grid-cols-2">
          {prev && <Step doc={prev} label="Previous" />}
          {next && <Step doc={next} label="Next" className="text-right sm:col-start-2" />}
        </nav>
      </article>
    </main>
  )
}

function Pages({ current }: { current: Doc }) {
  return (
    <div className="flex flex-col gap-5">
      {SECTIONS.map((s) => (
        <div key={s}>
          <p className="px-3 text-xs font-semibold tracking-wider text-muted uppercase">{s}</p>
          <ul className="mt-1.5 flex flex-col">
            {DOCS.filter((d) => d.section === s && !parentOf(d)).map((d) => (
              <li key={d.slug}>
                <PageLink doc={d} current={current} />
                {/* A part's subpages show while you're in that part; its page lists them all the time. */}
                {(d === current || parentOf(current) === d) && childrenOf(d).length > 0 && (
                  <ul className="ml-3 flex flex-col border-l border-line pl-2 text-[15px]">
                    {childrenOf(d).map((c) => <li key={c.slug}><PageLink doc={c} current={current} /></li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

const PageLink = ({ doc, current }: { doc: Doc; current: Doc }) => (
  <Link
    href={docHref(doc)}
    aria-current={doc === current ? "page" : undefined}
    className="block rounded-full px-3 py-1 font-medium text-ink-soft transition-colors hover:text-ink aria-[current=page]:bg-ink aria-[current=page]:text-white"
  >
    {doc.title}
  </Link>
)

function Step({ doc, label, className = "" }: { doc: Doc; label: string; className?: string }) {
  return (
    <Link href={docHref(doc)} className={`card block p-5 transition-shadow hover:shadow-float ${className}`}>
      <span className="text-sm text-muted">{label}</span>
      <span className="block font-semibold text-ink">{doc.title}</span>
    </Link>
  )
}
