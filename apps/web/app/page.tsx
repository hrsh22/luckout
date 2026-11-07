import { Catalog } from "@/components/catalog"
import { ConnectButton } from "@/components/connect-button"

export default function Home() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-8">
      <header className="flex items-center justify-between">
        <span className="font-heading text-xl font-bold">Luckout</span>
        <ConnectButton />
      </header>
      <div className="flex flex-col gap-3">
        <h1 className="font-heading text-5xl font-bold tracking-tight">Checkout, but lucky.</h1>
        <p className="text-muted-foreground text-lg">
          Buy the gift cards you already buy. Sometimes pay half. Sometimes pay nothing.
        </p>
      </div>
      <Catalog />
    </main>
  )
}
