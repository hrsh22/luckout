import { Shop } from "@/components/shop"

export default function Home() {
  return (
    <main className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        <h1 className="font-heading text-5xl font-bold tracking-tight">Checkout, but lucky.</h1>
        <p className="text-muted-foreground text-lg">
          Buy the gift cards you already buy. Sometimes pay half. Sometimes pay nothing. Always get your voucher.
        </p>
      </div>
      <Shop />
    </main>
  )
}
