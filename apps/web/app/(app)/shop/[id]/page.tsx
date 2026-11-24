import { VoucherPage } from "@/components/voucher-page"
import { Suspense } from "react"
import { MissingCard } from "./missing-card"

export default function Page() {
  return (
    <Suspense>
      <MissingCard>
        <VoucherPage />
      </MissingCard>
    </Suspense>
  )
}
