"use client"

import { AddressLink } from "@/components/admin/shared"
import { shortAccount } from "@/components/avatar"
import { Button } from "@/components/ui/button"
import { api, cancelled, errorMessage } from "@/lib/api"
import { explorer } from "@/lib/chain"
import { ownerTxProblem, PROGRAM_ID } from "@/lib/owner-tx"
import { useSession } from "@/lib/session"
import { useSubmitPrepared } from "@/lib/transactions"
import { oneAtATime } from "@/lib/utils"
import type { AdminOverview, OwnerAction } from "@luckout/api"
import { useConnectWallet } from "@privy-io/react-auth"
import { useWallets } from "@privy-io/react-auth/solana"
import { useQueryClient } from "@tanstack/react-query"
import { CircleAlert, ShieldCheck, Wallet } from "lucide-react"
import { toast } from "sonner"

// The owner is one key in our own wallet (Phantom or similar), never on the server (ADR-0015). The server prepares
// each owner transaction with our fee payer paying; the panel checks it is exactly what was asked (lib/owner-tx.ts),
// then the owner's wallet, connected here through Privy, signs it in its own prompt, and /transactions/submit sends it.

export type Owner = ReturnType<typeof useOwner>

export function useOwner(o: AdminOverview) {
  const { token } = useSession()
  const { wallets } = useWallets()
  const { connectWallet } = useConnectWallet()
  const submit = useSubmitPrepared()
  const qc = useQueryClient()
  const wallet = wallets.find((w) => w.address === o.program.owner)
  const proposed = wallets.find((w) => w.address === o.program.pendingOwner)
  // Owner transactions go to the program this site was built for, never to one the server reports.
  const elsewhere = o.program.id !== PROGRAM_ID
  const connect = () => connectWallet({ walletChainType: "solana-only", description: `Connect the owner's wallet, ${shortAccount(o.program.owner)}.` })

  /** Has `signer` (the owner by default) sign `action`, says how it went with an explorer link, and refreshes. True if it landed. */
  const sign = (action: OwnerAction, pending: string, done: string, signer = o.program.owner) =>
    oneAtATime(async () => {
      const w = wallets.find((x) => x.address === signer)
      if (elsewhere || !w) {
        toast.error(elsewhere ? "Owner actions are off" : `Connect ${shortAccount(signer)} first`)
        return false
      }
      const id = toast.loading(pending, { description: `Approve it in ${w.standardWallet.name}. Luckout pays the network fee.` })
      try {
        const prepared = await api((c) => c.admin.owner({ payload: action }), token)
        const problem = await ownerTxProblem(prepared.transaction, action, signer, o.program.usdcMint)
        if (problem) throw new Error(`Nothing was signed: the server's transaction is wrong (${problem}). Check the server before trying again.`)
        const signature = await submit(prepared, signer)
        toast.success(done, { id, description: undefined, action: { label: "View", onClick: () => window.open(explorer(signature), "_blank", "noopener") } })
        return true
      } catch (e) {
        if (cancelled(e)) toast("Cancelled in your wallet. Nothing was sent.", { id, description: undefined })
        else toast.error(errorMessage(e), { id, description: undefined })
        return false
      } finally {
        await Promise.all([qc.invalidateQueries({ queryKey: ["admin"] }), qc.invalidateQueries({ queryKey: ["shop-status"] })])
      }
    })

  /** Runs `f` (which opens what the action will do) once the owner's wallet is here; otherwise says why not. */
  const asOwner = (f: () => void) => () =>
    elsewhere
      ? toast.error("Owner actions are off", { description: `The server reports program ${o.program.id}; this site is built for ${PROGRAM_ID}.` })
      : wallet
      ? f()
      : toast("That needs the owner's wallet", { description: o.program.owner, action: { label: "Connect", onClick: connect } })

  return { wallet, proposed, elsewhere, connect, sign, asOwner, wallets }
}

/** Which connected wallet signs as the owner, or how to connect it; and an owner change waiting to be accepted. */
export function OwnerBanner({ o, owner }: { o: AdminOverview; owner: Owner }) {
  const pending = o.program.pendingOwner
  if (owner.elsewhere) {
    return (
      <p role="alert" className="flex items-start gap-3 rounded-[1.5rem] bg-bad-soft p-5 text-[15px] font-medium text-bad">
        <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          The server reports program {o.program.id}, but this site is built for {PROGRAM_ID}. Owner actions are off until they match: check the server's
          SOLANA_PROGRAM_ID and the site's NEXT_PUBLIC_SOLANA_PROGRAM_ID.
        </span>
      </p>
    )
  }
  if (pending && owner.proposed) {
    return (
      <div className="flex flex-col gap-4 rounded-[1.5rem] bg-lilac-soft p-5 sm:flex-row sm:items-center">
        <p className="flex flex-1 items-start gap-3 text-[15px]">
          <ShieldCheck size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            The owner proposed <b>{shortAccount(pending)}</b>, connected here in {owner.proposed.standardWallet.name}, as the program's new owner. Accepting
            hands it the pause, the reserve, Proceeds, the caps, the operator and the Pay Wallet.
          </span>
        </p>
        <Button onClick={() => void owner.sign({ _tag: "accept_owner" }, "Accepting ownership", "You own the program now", pending)}>Accept ownership</Button>
      </div>
    )
  }
  if (owner.wallet) {
    return (
      <div className="flex flex-col gap-3 rounded-[1.5rem] bg-good-soft p-5 text-good sm:flex-row sm:items-center">
        <p className="flex flex-1 items-start gap-3 text-[15px] font-medium">
          <ShieldCheck size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Owner actions sign in {owner.wallet.standardWallet.name} ({shortAccount(owner.wallet.address)}), the program's owner.
            {pending && <> You proposed <b>{shortAccount(pending)}</b> as owner; nothing changes until it accepts in its own wallet.</>}
          </span>
        </p>
        {pending && (
          <Button variant="light" size="sm" onClick={() => void owner.sign({ _tag: "propose_owner", newOwner: null }, "Withdrawing the proposal", "Proposal withdrawn")}>
            Withdraw the proposal
          </Button>
        )}
      </div>
    )
  }
  const here = owner.wallets.map((w) => `${w.standardWallet.name} ${shortAccount(w.address)}`).join(", ")
  return (
    <div className="flex flex-col gap-4 rounded-[1.5rem] bg-lilac-soft p-5 sm:flex-row sm:items-center">
      <p className="flex flex-1 items-start gap-3 text-[15px]">
        <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          The pause, the reserve, Proceeds and the program's settings need the owner's wallet, <AddressLink address={o.program.owner} />. Connect it here: it signs
          in its own prompt, and Luckout pays the fee. {here ? `Connected now: ${here}.` : ""} Any admin can stop sales and retry purchases.
          {pending && <> <b>{shortAccount(pending)}</b> is proposed as the new owner: connect that wallet to accept.</>}
        </span>
      </p>
      <Button onClick={owner.connect}><Wallet />Connect the owner's wallet</Button>
    </div>
  )
}
