import assert from "node:assert/strict"
import { test } from "node:test"
import { textBlocks } from "./text-blocks.ts"

test("Bitrefill's steps read as titled, numbered lists, with a step's own items under it", () => {
  assert.deepEqual(textBlocks("# On the app\n1. Open it\n2. Enter:\n  - Card number\n  - PIN\n3. Tap Add\n# On the website\n1. Go to example.com"), [
    { kind: "title", text: "On the app" },
    { kind: "steps", entries: [{ text: "Open it", sub: [] }, { text: "Enter:", sub: ["Card number", "PIN"] }, { text: "Tap Add", sub: [] }] },
    { kind: "title", text: "On the website" },
    { kind: "steps", entries: [{ text: "Go to example.com", sub: [] }] }
  ])
})

test("terms become separate points; without `list` a paragraph stays a paragraph", () => {
  assert.deepEqual(textBlocks("# Validity\n12 months.\nNo refunds.", true), [
    { kind: "title", text: "Validity" },
    { kind: "items", entries: [{ text: "12 months.", sub: [] }, { text: "No refunds.", sub: [] }] }
  ])
  assert.deepEqual(textBlocks("Start here (example.com)"), [{ kind: "text", text: "Start here (example.com)" }])
  assert.deepEqual(textBlocks("Note\n  - an item with nothing above it"), [
    { kind: "text", text: "Note" },
    { kind: "items", entries: [{ text: "an item with nothing above it", sub: [] }] }
  ], "an indented item after a paragraph is still an item")
})
