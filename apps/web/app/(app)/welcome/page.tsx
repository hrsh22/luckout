import { Welcome } from "@/components/welcome"
import type { Metadata } from "next"

export const metadata: Metadata = { title: "Welcome" }

export default function Page() {
  return <Welcome />
}
