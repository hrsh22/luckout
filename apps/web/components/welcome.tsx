"use client"

import { SignInButton } from "@/components/app-nav"
import { Avatar, shortAccount } from "@/components/avatar"
import { AddFundsPanel } from "@/components/funds"
import { ModePicker } from "@/components/mode-picker"
import { Money } from "@/components/money"
import { TelegramLink } from "@/components/telegram-link"
import { Button } from "@/components/ui/button"
import { useWalletActions } from "@/lib/actions"
import { usd } from "@/lib/format"
import { MODES, modeName, RECOMMENDED, sameMode } from "@/lib/modes"
import { markWelcomed, pendingMode, setPendingMode } from "@/lib/onboarding"
import { modePalette } from "@/lib/palette"
import { useSession } from "@/lib/session"
import type { Mode } from "@luckout/api"
import { Check, ShieldCheck, Sparkles, Zap } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"

const STEPS = ["Sign in", "Choose a mode", "Add funds", "Ready"] as const
type Step = 0 | 1 | 2 | 3

/**
 * Welcome: sign in, choose how you like to pay, add funds, done. Each step is one decision,
 * and nothing here buys anything. It runs as its own page (/welcome) or over the page a new
 * customer signed in on; `onDone` closes it there.
 */
export function Welcome({ onDone }: { onDone?: () => void }) {
  const { accountId, account, signInError } = useSession()
  const actions = useWalletActions()
  const router = useRouter()
  // Already signed in: start at the first real decision, with no step-to-step animation on open.
  const signedIn = !!accountId && account !== undefined
  const [step, setStep] = useState<Step>(signedIn ? 1 : 0)
  const [dir, setDir] = useState(1)
  const [mode, setMode] = useState<Mode>(
    (accountId && (account?.default_mode ?? pendingMode(accountId))) || MODES.find((m) => m.name === RECOMMENDED)!.mode
  )
  const [saving, setSaving] = useState(false)
  const top = useRef<HTMLDivElement>(null)
  const go = (s: Step) => {
    setDir(s > step ? 1 : -1)
    setStep(s)
    top.current?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  // Signed in (here or before): move on, keeping any mode already chosen.
  useEffect(() => {
    if (step !== 0 || !accountId || account === undefined) return
    const saved = account?.default_mode ?? pendingMode(accountId)
    if (saved) setMode(saved)
    go(1)
  }, [step, accountId, account]) // eslint-disable-line react-hooks/exhaustive-deps

  // Seen once is enough: leaving partway is skipping, and Welcome won't come back.
  useEffect(() => {
    if (step >= 1 && accountId) markWelcomed(accountId)
  }, [step, accountId])

  const confirmMode = async () => {
    if (!accountId) return
    if (account) {
      // Funds are already in: save it now, then skip the funds step.
      if (!sameMode(account.default_mode, mode)) {
        setSaving(true)
        const ok = await actions.setDefaultMode(mode)
        setSaving(false)
        if (!ok) return
      }
      go(3)
    } else {
      setPendingMode(accountId, mode)
      go(2)
    }
  }

  return (
    <div ref={top} className="mx-auto flex w-full max-w-[760px] scroll-mt-28 flex-col gap-8">
      <ol className="grid grid-cols-4 gap-2" aria-label="Welcome steps">
        {STEPS.map((label, i) => (
          <li key={label} className="flex flex-col gap-2" aria-current={i === step ? "step" : undefined}>
            <span className="h-1.5 overflow-hidden rounded-full bg-white">
              <motion.span className="block h-full rounded-full bg-ink" initial={false} animate={{ width: i <= step ? "100%" : "0%" }} transition={{ type: "spring", stiffness: 200, damping: 30 }} />
            </span>
            <span className={`hidden text-sm font-semibold sm:block ${i <= step ? "text-ink" : "text-muted"}`}>{label}</span>
          </li>
        ))}
      </ol>

      <AnimatePresence mode="wait" custom={dir} initial={false}>
        <motion.section
          key={step}
          custom={dir}
          variants={{
            enter: (d: number) => ({ opacity: 0, x: d * 40 }),
            center: { opacity: 1, x: 0 },
            exit: (d: number) => ({ opacity: 0, x: d * -40 })
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ type: "spring", stiffness: 320, damping: 32 }}
          className="flex flex-col gap-6"
        >
          {step === 0 && (
            <>
              <Heading title="Checkout, but lucky." body="Buy gift cards, top-ups and eSIMs with USDC. Pay the price, or add a little for a fair shot at cashback. Sign in with your NEAR wallet to start." />
              <div className="grid gap-3 sm:grid-cols-3">
                <Point icon={Zap} tint="sky" title="Codes in seconds" body="Bitrefill delivers the card the moment you buy." />
                <Point icon={Sparkles} tint="gold" title="Cashback by chance" body="Lucky modes can pay back part of the price, sometimes all of it." />
                <Point icon={ShieldCheck} tint="lilac" title="Checkable" body="Every Draw is on NEAR. Anyone can recompute it." />
              </div>
              <div className="card flex flex-col items-start gap-3 p-6">
                <SignInButton size="lg" label="Sign in with NEAR" inline />
                {signInError && <p role="alert" className={`text-sm font-medium ${signInError.cancelled ? "text-ink-soft" : "text-bad"}`}>{signInError.message}</p>}
                <p className="text-sm text-muted">Free: you sign one message, no transaction. HOT, Meteor, MyNearWallet and other NEAR wallets work.</p>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <Heading
                title="How do you like to pay?"
                body="This becomes your default in the shop and in Telegram. You can pick another mode for any purchase, or change it later in Wallet."
              />
              <ModePicker value={mode} onChange={setMode} label="Default mode" />
              <p className="text-sm text-muted">
                Every lucky mode averages 5.6% above the price over many purchases, and any cashback leaves you below it. Odds shown for a $20 card.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="lg" loading={saving} onClick={confirmMode}>Continue with {modeName(mode)}</Button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <Heading title="Add funds" body="Your balance pays for cards, and you can withdraw what you don't spend at any time." />
              <div className="card p-6 sm:p-8">
                <AddFundsPanel onDone={(ok) => ok && go(3)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => go(1)}>Back</Button>
                <Button variant="ghost" onClick={() => go(3)}>Skip for now</Button>
              </div>
            </>
          )}

          {step === 3 && accountId && (
            <>
              <Heading title="You're all set." body="Here's how your account is set up. All of it can be changed in Wallet." />
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="card flex flex-col gap-2 p-6">
                  <span className="flex items-center gap-2 text-sm text-muted"><Avatar id={accountId} size={20} />{shortAccount(accountId)}</span>
                  <span className="font-display text-4xl font-extrabold"><Money micro={account?.balance ?? 0} /></span>
                  <span className="text-sm text-muted">{account ? "in your balance" : "No funds yet. Add them any time."}</span>
                </div>
                <ModeTile mode={account?.default_mode ?? pendingMode(accountId) ?? mode} saved={!!account} />
                <div className="card flex flex-col gap-2 p-6">
                  <span className="text-sm text-muted">Spending limits</span>
                  <span className="font-display text-xl leading-tight font-extrabold">
                    {usd(account?.per_purchase_limit ?? 50_000_000)} a purchase, {usd(account?.daily_limit ?? 100_000_000)} a day
                  </span>
                  <span className="text-sm text-muted">The contract enforces these, even for Telegram.</span>
                </div>
              </div>
              <TelegramLink />
              <div>
                <Button size="lg" onClick={() => (onDone ? onDone() : router.push("/shop"))}>
                  {onDone ? "Start shopping" : "Find a card"}
                </Button>
              </div>
            </>
          )}
        </motion.section>
      </AnimatePresence>
    </div>
  )
}

function Heading({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h1 className="font-display text-5xl leading-[0.95] font-extrabold tracking-[-0.03em] sm:text-[64px]">{title}</h1>
      <p className="mt-4 max-w-[56ch] text-lg text-ink-soft">{body}</p>
    </div>
  )
}

const TINTS = {
  sky: { bg: "var(--color-sky-soft)", fg: "#2B7CC4" },
  gold: { bg: "var(--color-gold-soft)", fg: "#A86B00" },
  lilac: { bg: "var(--color-lilac-soft)", fg: "#6F4BEA" }
}

function Point({ icon: Icon, tint, title, body }: { icon: typeof Zap; tint: keyof typeof TINTS; title: string; body: string }) {
  return (
    <div className="card p-6">
      <span className="mb-4 grid size-12 place-items-center rounded-2xl" style={{ background: TINTS[tint].bg, color: TINTS[tint].fg }}><Icon size={22} /></span>
      <b className="font-display block text-xl font-extrabold">{title}</b>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  )
}

function ModeTile({ mode, saved }: { mode: Mode; saved: boolean }) {
  const p = modePalette(mode)
  return (
    <div className="flex flex-col gap-2 rounded-[1.75rem] p-6" style={{ background: p.tile, color: p.ink }}>
      <span className="text-sm opacity-75">Default mode</span>
      <span className="font-display flex items-center gap-2 text-4xl font-extrabold">{modeName(mode)}{saved && <Check size={26} strokeWidth={3} />}</span>
      <span className="text-sm opacity-75">{saved ? "Saved to your account" : "Saved with your first deposit"}</span>
    </div>
  )
}
