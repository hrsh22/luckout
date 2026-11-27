import { DOCS } from "@/lib/docs"
import { notFound } from "next/navigation"
import { DocView, docMetadata } from "../doc-view"

type Props = { params: Promise<{ slug: string }> }

const docAt = async (params: Props["params"]) => {
  const { slug } = await params
  return DOCS.find((d) => d.slug !== "" && d.slug === slug) ?? notFound()
}

// Every page is built at deploy; a slug not in the list is a 404.
export const dynamicParams = false
export const generateStaticParams = () => DOCS.filter((d) => d.slug !== "").map((d) => ({ slug: d.slug }))
export const generateMetadata = async ({ params }: Props) => docMetadata(await docAt(params))

export default async function Doc({ params }: Props) {
  return <DocView doc={await docAt(params)} />
}
