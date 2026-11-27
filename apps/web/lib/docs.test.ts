import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { BITREFILL_NOTE, docFile, DOCS } from "./docs.ts"

const dir = new URL("../content/docs/", import.meta.url)
const files = readdirSync(dir).filter((f) => f.endsWith(".mdx"))
const read = (f: string) => readFileSync(new URL(f, dir), "utf8")

// The words CONTEXT.md avoids for a purchase, a Draw or our margin.
const AVOIDED = /\b(bets?|betting|wagers?|gambl\w*|lotter(y|ies)|winnings|prizes?|spins?|house edge|RTP|stakes?)\b/i

test("every page in the list has its file, and every file is in the list (else it's missing from the sitemap)", () => {
  assert.deepEqual(DOCS.map((d) => `${docFile(d)}.mdx`).sort(), [...files].sort())
  assert.equal(new Set(DOCS.map((d) => d.slug)).size, DOCS.length)
})

test("titles and descriptions are unique, and descriptions fit a search result", () => {
  assert.equal(new Set(DOCS.map((d) => d.title)).size, DOCS.length)
  assert.equal(new Set(DOCS.map((d) => d.description)).size, DOCS.length)
  for (const d of DOCS) assert.ok(d.description.length >= 70 && d.description.length <= 160, `${d.title}: ${d.description.length} characters`)
})

test("pages use the glossary's words, name Bitrefill only with the note, and leave the h1 to the layout", () => {
  for (const f of files) {
    const text = read(f)
    assert.doesNotMatch(text, AVOIDED, f)
    if (/bitrefill/i.test(text)) assert.ok(text.includes(BITREFILL_NOTE), `${f} names Bitrefill without the note`)
    assert.doesNotMatch(text, /^# /m, `${f}: the page's title is its h1`)
  }
})
