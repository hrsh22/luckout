"use client"

import type { Owner } from "@/components/admin/owner"
import { shortAccount } from "@/components/avatar"
import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { api, errorMessage } from "@/lib/api"
import { useSession } from "@/lib/session"
import type { AdminBuffer } from "@luckout/api"
import { isAddress } from "@solana/kit"
import { useEffect, useState } from "react"

// Upgrades the program from a build the operator uploaded to a buffer and handed to the upgrade authority
// (deploy/README.md). The panel shows the build's hash to check against CI's before the upgrade authority's wallet
// signs; the buffer's rent comes back to that wallet.

export function UpgradeSheet({ open, onClose, owner }: { open: boolean; onClose: () => void; owner: Owner }) {
  const { token } = useSession()
  const [value, setValue] = useState("")
  const [checked, setChecked] = useState<AdminBuffer>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setValue("")
      setChecked(undefined)
      setError(undefined)
    }
  }, [open])
  const v = value.trim()
  const b = checked?.address === v ? checked : undefined
  const problem = !b
    ? undefined
    : !b.program.upgradeAuthority
    ? "The program can no longer be upgraded"
    : b.authority !== b.program.upgradeAuthority
    ? `The buffer is ${b.authority ? shortAccount(b.authority) : "nobody"}'s, not the upgrade authority's`
    : b.size > b.program.room
    ? `The build needs ${b.size - b.program.room} more bytes: extend the program first`
    : b.hash === b.program.hash
    ? "That's the build running now"
    : undefined

  const check = async () => {
    setBusy(true)
    setError(undefined)
    try {
      setChecked(await api((c) => c.admin.buffer({ params: { address: v } }), token))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Upgrade the program"
      description="Paste the buffer holding the new build. Before signing, check its hash against the one in CI's program-build summary for the release commit, and pause first so pending Draws can finish."
    >
      <div className="flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Buffer's address</span>
          <input className="field font-mono text-sm!" value={value} onChange={(e) => setValue(e.target.value)} autoCapitalize="none" spellCheck={false} />
        </label>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        {b && (
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted">New build's hash</dt>
            <dd className="font-mono break-all">{b.hash}</dd>
            <dt className="text-muted">Running now</dt>
            <dd className="font-mono break-all text-muted">{b.program.hash}</dd>
            <dt className="text-muted">Size</dt>
            <dd>{b.size.toLocaleString()} bytes, of {b.program.room.toLocaleString()} the program has room for</dd>
            <dt className="text-muted">Signs</dt>
            <dd>{b.program.upgradeAuthority ? shortAccount(b.program.upgradeAuthority) : "nobody"}, the upgrade authority</dd>
          </dl>
        )}
        {!b
          ? <Button size="lg" disabled={!isAddress(v) || busy} onClick={() => void check()}>{busy ? "Checking…" : isAddress(v) ? "Check the build" : "Paste a buffer's address"}</Button>
          : (
            <Button
              size="lg"
              variant="danger"
              disabled={!!problem}
              onClick={async () =>
                (await owner.sign({ _tag: "upgrade", buffer: b.address }, "Upgrading the program", "The program runs the new build", b.program.upgradeAuthority!)) && onClose()}
            >
              {problem ?? `Upgrade to ${b.hash.slice(0, 8)}…`}
            </Button>
          )}
      </div>
    </Sheet>
  )
}
