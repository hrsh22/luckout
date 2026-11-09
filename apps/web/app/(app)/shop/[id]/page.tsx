import { VoucherPage } from "@/components/voucher-page"
import { Suspense } from "react"

export default function Page() {
  return (
    <Suspense>
      <VoucherPage />
    </Suspense>
  )
}
