"use client"

import { shortAccount } from "@/components/avatar"
import { Bar, Toggle } from "@/components/admin/shared"
import { Button } from "@/components/ui/button"
import { api, errorMessage } from "@/lib/api"
import { explorerAccount } from "@/lib/near"
import { useSession } from "@/lib/session"
import { type AdminOverview, RelaySettings } from "@luckout/api"
import { useQueryClient } from "@tanstack/react-query"
import { Zap } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

export function RelayerCard({ r }: { r: AdminOverview["relay"] }) {
  const { token } = useSession()
  const qc = useQueryClient()
  const [per, setPer] = useState(String(r.settings.perAccountDaily))
  const [all, setAll] = useState(String(r.settings.allDaily))
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPer(String(r.settings.perAccountDaily))
    setAll(String(r.settings.allDaily))
  }, [r.settings.perAccountDaily, r.settings.allDaily])

  const nPer = Number(per)
  const nAll = Number(all)
  const valid = Number.isInteger(nPer) && nPer >= 0 && nPer <= 1000 && Number.isInteger(nAll) && nAll >= 0 && nAll <= 100_000 && per !== "" && all !== ""
  const changed = nPer !== r.settings.perAccountDaily || nAll !== r.settings.allDaily

  const save = async (next: { enabled: boolean; perAccountDaily: number; allDaily: number }, done: string) => {
    setBusy(true)
    try {
      await api((c) => c.admin.relay({ payload: new RelaySettings(next) }), token)
      toast.success(done)
      await qc.invalidateQueries({ queryKey: ["admin"] })
    } catch (e) {
      toast.error(errorMessage(e))
    }
    setBusy(false)
  }

  return (
    <div className="card flex flex-col gap-6 p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-display flex items-center gap-2 text-3xl font-extrabold"><Zap size={24} aria-hidden="true" />Relayer</h2>
          <p className="mt-1 text-ink-soft">
            {!r.configured ? "No relayer key on the server, so customers' wallets pay their own fees." : r.settings.enabled ? "Paying customers' network fees." : "Off: customers' wallets pay their own fees."}
          </p>
        </div>
        <Toggle
          on={r.settings.enabled}
          busy={busy || !r.configured}
          label="Relayer on"
          onChange={(enabled) => save({ ...r.settings, enabled }, enabled ? "Relayer on: Luckout pays customers' fees" : "Relayer off: customers' wallets pay their fees")}
        />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <p className="font-semibold">Free transactions, last 24 hours</p>
          <p className="text-sm text-muted">{r.usedToday} of {r.settings.allDaily}</p>
        </div>
        <Bar value={r.settings.allDaily ? r.usedToday / r.settings.allDaily : 1} tone={r.usedToday >= r.settings.allDaily * 0.8 ? "warn" : "ink"} />
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        {[
          { label: "Per account a day", value: per, set: setPer },
          { label: "Everyone a day", value: all, set: setAll }
        ].map((f) => (
          <label key={f.label} className="flex flex-col gap-2">
            <span className="text-sm font-semibold">{f.label}</span>
            <input className="field" inputMode="numeric" value={f.value} onChange={(e) => f.set(e.target.value.replace(/\D/g, ""))} />
          </label>
        ))}
        <Button loading={busy} disabled={!changed || !valid} onClick={() => save({ enabled: r.settings.enabled, perAccountDaily: nPer, allDaily: nAll }, "Relayer caps saved")}>
          Save caps
        </Button>
      </div>

      {r.topAccounts.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink-soft">Most relays today</p>
          <ul className="flex flex-col divide-y divide-line">
            {r.topAccounts.map((t) => (
              <li key={t.accountId} className="flex items-center justify-between py-2 text-sm">
                <a href={explorerAccount(t.accountId)} target="_blank" rel="noreferrer" className="truncate underline-offset-2 hover:underline">{shortAccount(t.accountId)}</a>
                <span className="text-muted">{t.count} of {r.settings.perAccountDaily}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
