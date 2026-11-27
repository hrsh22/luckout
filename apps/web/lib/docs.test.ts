import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { BITREFILL_NOTE, docFile, DOCS } from "./docs.ts"

const dir = new URL("../content/docs/", import.meta.url)
// Subpages sit in folders: "add-funds/ore.mdx".
const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".mdx"))
const read = (f: string) => readFileSync(new URL(f, dir), "utf8")

// The words CONTEXT.md avoids for a purchase, a Draw or our margin.
const AVOIDED = /\b(bets?|betting|wagers?|gambl\w*|lotter(y|ies)|winnings|prizes?|spins?|house edge|RTP|stakes?)\b/i

test("every page in the list has its file, and every file is in the list (else it's missing from the sitemap)", () => {
  assert.deepEqual(DOCS.map((d) => `${docFile(d)}.mdx`).sort(), [...files].sort())
  assert.equal(new Set(DOCS.map((d) => d.slug)).size, DOCS.length)
})

test("titles and descriptions are unique, fit a search result, and leave Bitrefill to the pages", () => {
  assert.equal(new Set(DOCS.map((d) => d.title)).size, DOCS.length)
  assert.equal(new Set(DOCS.map((d) => d.description)).size, DOCS.length)
  for (const d of DOCS) {
    assert.ok(d.description.length >= 70 && d.description.length <= 160, `${d.title}: ${d.description.length} characters`)
    // A search result or llms.txt shows these alone, with no room for the note.
    assert.doesNotMatch(`${d.title} ${d.description}`, /bitrefill/i, d.title)
  }
})

// The #sections a page has: its headings, as rehype-slug names them, and its folded questions (Q in components/docs.tsx).
const anchors = (d: (typeof DOCS)[number]) => {
  const text = read(`${docFile(d)}.mdx`)
  return new Set([
    "in-this-part",
    ...[...text.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1]!.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-")),
    ...[...text.matchAll(/<Q q="(.+?)"/g)].map((m) => m[1]!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""))
  ])
}

test("every /docs link, in the app, the bot and the pages, reaches a page and a section that exist", () => {
  const web = new URL("../", import.meta.url)
  const code = [
    ...["app", "components", "lib"].flatMap((d) =>
      readdirSync(new URL(`${d}/`, web), { recursive: true, encoding: "utf8" })
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => readFileSync(new URL(`${d}/${f}`, web), "utf8"))
    ),
    // The Agent's prompt gives pages as `${web}/docs/modes`.
    readFileSync(new URL("../server/src/Agent.ts", web), "utf8")
  ]
  const links = [
    // A whole path after a quote or a `${...}`; `/docs/${d.slug}` is skipped.
    ...code.flatMap((t) => [...t.matchAll(/["'`}](\/docs[\w/-]*(?:#[\w-]+)?)(?![\w/#$-])/g)].map((m) => m[1]!)),
    ...files.flatMap((f) => [...read(f).matchAll(/\]\((\/docs[^)\s]*)\)/g)].map((m) => m[1]!))
  ]
  assert.ok(links.length > 50, `found only ${links.length} links`)
  for (const link of new Set(links)) {
    const [path, hash] = link.split("#")
    const doc = DOCS.find((d) => (d.slug ? `/docs/${d.slug}` : "/docs") === path)
    assert.ok(doc, `${link}: no such page`)
    if (hash) assert.ok(anchors(doc).has(hash), `${link}: no such section`)
  }
})

test("pages use the glossary's words, name Bitrefill only with the note, and leave the h1 to the layout", () => {
  for (const f of files) {
    const text = read(f)
    assert.doesNotMatch(text, AVOIDED, f)
    if (/bitrefill/i.test(text)) assert.ok(text.includes(BITREFILL_NOTE), `${f} names Bitrefill without the note`)
    assert.doesNotMatch(text, /^# /m, `${f}: the page's title is its h1`)
  }
})
