import { NoPage } from "@/components/site-chrome"

// A Draw Proof that isn't on chain (notFound()), under the marketing header; these pages bring their own <main>.
export default function NotFound() {
  return (
    <main id="main" className="mx-auto w-full max-w-[1000px] px-6 pt-14 sm:px-10">
      <NoPage />
    </main>
  )
}
