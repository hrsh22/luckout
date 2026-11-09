import { Welcome } from "@/components/welcome"
import type { Metadata } from "next"
import { Suspense } from "react"

export const metadata: Metadata = { title: "Welcome" }

export default function Page() {
  return (
    <Suspense>
      <Welcome />
    </Suspense>
  )
}
