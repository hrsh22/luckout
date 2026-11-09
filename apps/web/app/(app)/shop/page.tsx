import { Catalog } from "@/components/catalog"
import { Suspense } from "react"

export default function ShopPage() {
  return (
    <Suspense>
      <Catalog />
    </Suspense>
  )
}
