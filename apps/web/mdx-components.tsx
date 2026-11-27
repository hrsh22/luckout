import { docLink as link, Table, Td, Th } from "@/components/docs"
import type { MDXComponents } from "mdx/types"
import Link from "next/link"

// How the docs' MDX looks (content/docs). @next/mdx needs this file at the app's root.

/** A heading links to itself (rehype-slug gives the id), so the app and the bot can point at a section. */
const heading = (Tag: "h2" | "h3", className: string) =>
  function Heading({ id, children }: React.ComponentProps<"h2">) {
    return (
      <Tag id={id} className={`scroll-mt-28 text-ink ${className}`}>
        <a href={`#${id}`} className="decoration-2 underline-offset-4 hover:underline">{children}</a>
      </Tag>
    )
  }

const components: MDXComponents = {
  h2: heading("h2", "font-display mt-14 text-[30px] leading-tight font-extrabold tracking-[-0.02em] sm:text-[34px]"),
  h3: heading("h3", "mt-8 text-xl font-semibold"),
  p: (p) => <p className="mt-4" {...p} />,
  ul: (p) => <ul className="mt-4 flex list-disc flex-col gap-2 pl-5 marker:text-ink/30" {...p} />,
  ol: (p) => <ol className="mt-4 flex list-decimal flex-col gap-2 pl-5 marker:font-semibold marker:text-ink" {...p} />,
  strong: (p) => <strong className="font-semibold text-ink" {...p} />,
  code: (p) => <code className="rounded-md bg-soft px-1.5 py-0.5 font-mono text-[0.875em] break-all text-ink" {...p} />,
  a: ({ href = "", ...p }) =>
    href.startsWith("/") || href.startsWith("#")
      ? <Link href={href} className={link} {...p} />
      : <a href={href} className={link} target="_blank" rel="noreferrer" {...p} />,
  table: Table,
  th: Th,
  td: Td
}

export function useMDXComponents(): MDXComponents {
  return components
}
