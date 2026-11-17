// Which of our NEAR accounts the admin panel may name in an owner's transaction or send NEAR to, worked out from the
// contract id this site was built with, never from what the server reports: a server that is compromised, or a reply
// altered on the way, must not be able to put its own account into a transaction the owner signs.
// No imports, so `node --test` can load it.

/**
 * Our accounts are the contract's siblings: app.<root> is the contract, server.<root> the operator, relayer.<root>
 * the relayer and treasury.<root> the treasury (contract/deploy-mainnet.sh creates them so). Undefined for a contract
 * named otherwise: the panel then names none of them and says why.
 */
export const ourAccounts = (contractId: string) => {
  if (!contractId.startsWith("app.")) return undefined
  const root = contractId.slice("app.".length)
  return { contract: contractId, operator: `server.${root}`, relayer: `relayer.${root}`, treasury: `treasury.${root}` }
}

/**
 * What the treasury card shows, from what the server reports and the treasury this site was built for (`ours`).
 * "server-differs": the server signs as another account; the owner is told to check the server, never offered to
 * point the contract at it. "mismatch": the server is ours and the contract points elsewhere; pointing it at ours is
 * the fix.
 */
export const treasuryMode = (
  t: { readonly accountId?: string | undefined; readonly contractTreasury?: string | undefined; readonly dailyCap: number },
  ours: string | undefined
) =>
  !t.accountId
    ? "none"
    : !ours
    ? "unknown"
    : t.accountId !== ours
    ? "server-differs"
    : t.contractTreasury !== ours
    ? "mismatch"
    : t.dailyCap > 0
    ? "auto"
    : "manual"
