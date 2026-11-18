// Bitrefill's steps and terms as the server shapes them (Voucher.howToRedeem): "# " a title, "1. " a step,
// "- " an item, two spaces more for an item inside one, anything else a paragraph.

export type Entry = { text: string; sub: Array<string> }
export type Block =
  | { kind: "title"; text: string }
  | { kind: "steps" | "items"; entries: Array<Entry> }
  | { kind: "text"; text: string }

/** The lines as blocks: an item inside a step or item joins its `sub`; with `list`, plain paragraphs become items. */
export const textBlocks = (text: string, list = false): Array<Block> => {
  const out: Array<Block> = []
  const add = (kind: "steps" | "items", entry: string) => {
    const last = out.at(-1)
    if (last?.kind === kind) last.entries.push({ text: entry, sub: [] })
    else out.push({ kind, entries: [{ text: entry, sub: [] }] })
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const step = line.match(/^\d+\.\s+(.+)$/)?.[1]
    const item = line.match(/^-\s+(.+)$/)?.[1]
    const last = out.at(-1)
    if (/^\s{2}/.test(raw) && (step ?? item) && (last?.kind === "steps" || last?.kind === "items")) last.entries.at(-1)!.sub.push((step ?? item)!)
    else if (line.startsWith("# ")) out.push({ kind: "title", text: line.slice(2) })
    else if (step) add("steps", step)
    else if (item || list) add("items", item ?? line)
    else out.push({ kind: "text", text: line })
  }
  return out
}
