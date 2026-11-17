// Spending Limit constants with no Effect import, so pages that only format a limit don't load the API schema.

/** New accounts' Spending Limits in micro-USDC, as the contract sets them (DEFAULT_*_LIMIT). */
export const DEFAULT_LIMITS = { perPurchase: 200_000_000, daily: 1_000_000_000 } as const
/** "No limit": u128::MAX, so the contract's check never binds. Sent as this string, never through a JS number. */
export const NO_LIMIT = "340282366920938463463374607431768211455"
/** A limit past $9 billion (u128::MAX included) is no limit at all: say so, never show it in dollars. */
export const noLimit = (micro: string | number) => Number(micro) > Number.MAX_SAFE_INTEGER
