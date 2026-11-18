// What a customer needs from a card's Redemption Data, labelled the same way on the web and in the bot.
// Bitrefill keeps a card's main secret in `code`, or in `pin` when the card has no code, and adds any more under
// `extraFields`: a Swiggy card's gift code comes as `pin` and its PIN as extraFields["PIN Code"].

export type RedemptionField = { readonly label: string; readonly value: string }

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)

export const redemptionFields = (r: Readonly<Record<string, unknown>> | undefined) => {
  const extra = r?.extraFields
  const extras: Array<RedemptionField> = Object.entries(extra !== null && typeof extra === "object" ? extra : {}).flatMap(([label, v]) => {
    const value = text(v)
    return value ? [{ label, value }] : []
  })
  const code = text(r?.code)
  const pin = text(r?.pin)
  const pinIsCode = !code && extras.some((e) => /\bpin\b/i.test(e.label))
  const other = text(r?.other)
  return {
    secrets: [
      ...(code ? [{ label: "Code", value: code }] : []),
      ...(pin ? [{ label: pinIsCode ? "Code" : "PIN", value: pin }] : []),
      ...extras
    ],
    // Free text, often extraFields again ("PIN Code: …"): kept only when it says more.
    other: other && !(extras.length > 0 && extras.every((e) => other.includes(e.value))) ? other : undefined,
    link: text(r?.link),
    instructions: text(r?.instructions),
    expires: text(r?.expirationTime) ?? text(r?.expiration_date)
  }
}
