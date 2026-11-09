"use client"

import { SignInButton } from "@/components/app-nav"
import { useSession } from "@/lib/session"
import { Wallet } from "lucide-react"
import { motion } from "motion/react"

/** Shown wherever a page needs an account. Connecting and signing in are one step. */
export function SignInCard({ title, body }: { title: string; body: string }) {
  const { signInError } = useSession()
  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="card relative max-w-2xl overflow-hidden p-8 sm:p-10">
      <div className="blob -top-20 -right-16 size-64 bg-lilac/40" aria-hidden="true" />
      <div className="blob -bottom-24 left-10 size-56 bg-gold/30" aria-hidden="true" />
      <div className="relative flex flex-col items-start">
        <span className="mb-5 grid size-14 place-items-center rounded-2xl bg-ink text-white"><Wallet /></span>
        <h2 className="font-display text-4xl leading-none font-extrabold">{title}</h2>
        <p className="mt-3 max-w-md text-ink-soft">{body}</p>
        <div className="mt-6"><SignInButton size="lg" label="Sign in with NEAR" /></div>
        {signInError && <p role="alert" className="mt-3 text-sm font-medium text-bad">{signInError}</p>}
        <p className="mt-4 text-sm text-muted">Free: you sign one message, no transaction. HOT, Meteor, MyNearWallet and other NEAR wallets work.</p>
      </div>
    </motion.section>
  )
}
