// Spending Limit constants with no Effect import, so pages that only format a limit don't load the API schema.

/** New accounts' Spending Limits in micro-USDC, as the contract sets them (DEFAULT_*_LIMIT). */
export const DEFAULT_LIMITS = { perPurchase: 200_000_000, daily: 1_000_000_000 } as const
/** "No limit": u64::MAX, so the program's check never binds. Sent as this string, never through a JS number. */
export const NO_LIMIT = "18446744073709551615"
/**
 * Bitrefill's own purchase limits, in micro-USDC (help.bitrefill.com, "Is there a purchasing/top up limit?", read
 * 2026-11-17). A guest's count per Checkout Email. Bitrefill has no API for an account's level, so a connected
 * customer is shown both account levels: `basic` applies until they verify their identity with Bitrefill.
 */
export const GUEST_LIMITS = { orders: 15, daily: 500_000_000, monthly: 1_000_000_000 } as const
export const BITREFILL_ACCOUNT_LIMITS = {
  basic: { orders: 15, perCard: 2_000_000_000, daily: 5_000_000_000, monthly: 10_000_000_000 },
  verified: { orders: 25, perCard: 2_000_000_000, daily: 10_000_000_000, monthly: 50_000_000_000 }
} as const
/** A limit past $9 billion (u64::MAX included) is no limit at all: say so, never show it in dollars. */
export const noLimit = (micro: string | number) => Number(micro) > Number.MAX_SAFE_INTEGER
