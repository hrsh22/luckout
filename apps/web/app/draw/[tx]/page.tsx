import { DrawProof } from "@/components/draw-proof"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Draw Proof · Luckout", description: "Recompute this Draw yourself, from the chain." }

export default async function Page({ params }: { params: Promise<{ tx: string }> }) {
  return <DrawProof tx={(await params).tx} />
}
