import { DOCS } from "@/lib/docs"
import { DocView, docMetadata } from "./doc-view"

const doc = DOCS[0]!

export const metadata = docMetadata(doc)

export default function Docs() {
  return <DocView doc={doc} />
}
