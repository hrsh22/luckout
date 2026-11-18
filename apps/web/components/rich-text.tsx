/**
 * Bitrefill's steps and terms, laid out (lib/text-blocks.ts): steps get numbers, their own items sit under them
 * as small labels ("Enter:" Card number, PIN), and `list` turns plain paragraphs into items, so a wall of terms
 * reads as separate points.
 */

import { type Entry, textBlocks } from "@/lib/text-blocks"

export function RichText({ text, list = false }: { text: string; list?: boolean }) {
  return (
    <div className="flex max-w-[64ch] flex-col gap-3 text-[0.9375rem] leading-relaxed text-ink-soft">
      {textBlocks(text, list).map((b, i) =>
        b.kind === "title"
          ? <h3 key={i} className="pt-2 font-semibold text-ink first:pt-0">{b.text}</h3>
          : b.kind === "text"
          ? <p key={i}>{b.text}</p>
          : b.kind === "steps"
          ? (
            <ol key={i} className="flex flex-col gap-2.5">
              {b.entries.map((e, n) => (
                <li key={n} className="flex gap-3">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-soft text-xs font-semibold text-ink tabular-nums" aria-hidden="true">{n + 1}</span>
                  <EntryText e={e} />
                </li>
              ))}
            </ol>
          )
          : (
            <ul key={i} className="flex flex-col gap-2">
              {b.entries.map((e, n) => (
                <li key={n} className="flex gap-3">
                  <span className="mt-[0.6875rem] size-1.5 shrink-0 rounded-full bg-ink/25" aria-hidden="true" />
                  <EntryText e={e} />
                </li>
              ))}
            </ul>
          )
      )}
    </div>
  )
}

function EntryText({ e }: { e: Entry }) {
  return (
    <div className="min-w-0">
      {e.text}
      {e.sub.length > 0 && (
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {e.sub.map((s, k) => <span key={k} className="rounded-full bg-soft px-2.5 py-0.5 text-sm font-medium text-ink">{s}</span>)}
        </span>
      )}
    </div>
  )
}
