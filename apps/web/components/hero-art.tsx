"use client"

import { MotionConfig, motion, type Variants } from "motion/react"
import { Gift, ShieldCheck, Zap } from "lucide-react"

const rise: Variants = {
  hidden: { opacity: 0, y: 40, rotate: 0 },
  show: (c: { delay: number; rotate: number }) => ({
    opacity: 1,
    y: 0,
    rotate: c.rotate,
    transition: { type: "spring", stiffness: 120, damping: 16, delay: c.delay }
  })
}

const R = 80
const C = 2 * Math.PI * R

/**
 * The landing page's one orchestrated moment: a purchase that just came back 40% cheaper, with the
 * mode it was bought on and the card around it. Numbers are a real Classic outcome on a $20 card.
 */
export function HeroArt() {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div aria-hidden="true" initial="hidden" animate="show" className="relative mx-auto h-[560px] w-full max-w-[560px] lg:h-[600px]">
        <motion.div
          variants={rise}
          custom={{ delay: 0.15, rotate: -7 }}
          className="absolute top-10 left-0 w-[236px] rounded-[1.75rem] p-5 text-[#1D1240] shadow-pop"
          style={{ background: "linear-gradient(160deg,#CDBCFF,#A98BFF 60%,#8C67FF)" }}
        >
          <span className="pill">Classic, +20%</span>
          <p className="font-display mt-4 text-[40px] leading-none font-extrabold">40%</p>
          <p className="text-sm opacity-75">of buyers get cashback</p>
          <div className="mt-4 flex h-2 gap-[3px] overflow-hidden rounded-full">
            {[60, 24, 7, 4, 3, 2].map((w, i) => (
              <i key={i} className="h-full rounded-full" style={{ flexGrow: w, background: i === 0 ? "rgb(29 18 64 / 0.22)" : ["#FFEBB0", "#FFE08A", "#FFD466", "#FFC53D", "#FF9F1C"][i - 1] }} />
            ))}
          </div>
        </motion.div>

        <motion.div
          variants={rise}
          custom={{ delay: 0.3, rotate: 6 }}
          className="voucher absolute top-[300px] left-[-10px] w-[240px] rounded-[1.5rem] p-5 text-[#2A1206] shadow-pop sm:left-[-24px]"
          style={{ background: "linear-gradient(160deg,#FFB788,#FF8A4C 58%,#FF6F3D)" }}
        >
          <span className="flex items-center gap-2 text-sm font-semibold opacity-80"><Gift size={16} />Gift card</span>
          <p className="font-display mt-6 text-[44px] leading-none font-extrabold">$20</p>
          <p className="mt-1 text-sm opacity-75">Code delivered in 6 seconds</p>
        </motion.div>

        <motion.div
          variants={rise}
          custom={{ delay: 0, rotate: 0 }}
          className="absolute top-0 right-0 z-10 h-[560px] w-[280px] overflow-hidden rounded-[46px] border-[10px] border-ink bg-white shadow-pop sm:right-6"
        >
          <span className="absolute top-2 left-1/2 h-6 w-[86px] -translate-x-1/2 rounded-full bg-ink" />
          <div className="flex justify-between px-5 pt-3 text-[13px] font-semibold"><b>9:41</b><span className="flex gap-1"><i className="h-2.5 w-3 rounded-sm bg-ink/70" /><i className="h-2.5 w-4 rounded-sm bg-ink" /></span></div>
          <div className="px-5 pt-7 text-center">
            <small className="text-muted">Gift card, $20, on Classic</small>
            <div className="relative mx-auto mt-5 size-[190px]">
              <svg viewBox="0 0 190 190" className="-rotate-90">
                <defs>
                  <linearGradient id="hero-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FFD466" /><stop offset="1" stopColor="#FF9F1C" /></linearGradient>
                </defs>
                <circle cx="95" cy="95" r={R} fill="none" stroke="#f1f0f7" strokeWidth="18" />
                <motion.circle
                  cx="95" cy="95" r={R} fill="none" stroke="url(#hero-ring)" strokeWidth="18" strokeLinecap="round"
                  strokeDasharray={C}
                  initial={{ strokeDashoffset: C }}
                  animate={{ strokeDashoffset: C * 0.6 }}
                  transition={{ type: "spring", stiffness: 50, damping: 18, delay: 0.6 }}
                />
              </svg>
              <div className="absolute inset-0 grid place-content-center">
                <b className="font-display text-[52px] leading-none font-extrabold">$9.60</b>
                <small className="text-muted">cashback</small>
              </div>
            </div>
            <div className="mt-4 flex justify-center gap-2 text-[13px] font-semibold">
              <span className="rounded-full bg-soft px-3 py-1.5 whitespace-nowrap">Paid $14.40</span>
              <span className="rounded-full bg-gold-soft px-3 py-1.5 whitespace-nowrap text-gold-ink">$5.60 under</span>
            </div>
          </div>
          <div className="absolute inset-x-4 bottom-6 rounded-[1.25rem] bg-soft p-3 text-left">
            <small className="text-muted">Code</small>
            <p className="font-mono text-[15px] font-semibold tracking-wide">X7Q2-9KDA-PL4M</p>
          </div>
        </motion.div>

        <motion.span variants={rise} custom={{ delay: 0.55, rotate: 6 }} className="sticker absolute top-24 right-[-8px] z-20 bg-lilac text-white">
          <ShieldCheck size={16} strokeWidth={2.4} />Provably fair
        </motion.span>
        <motion.span variants={rise} custom={{ delay: 0.65, rotate: -8 }} className="sticker absolute top-[480px] left-6 z-20 bg-sky">
          <Zap size={16} strokeWidth={2.4} />Code in seconds
        </motion.span>
        <motion.span variants={rise} custom={{ delay: 0.75, rotate: 4 }} className="sticker absolute top-[380px] right-[-16px] z-20 bg-gold text-gold-ink">
          100% off 2% of the time
        </motion.span>
      </motion.div>
    </MotionConfig>
  )
}
