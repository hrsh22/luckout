// Sends a transaction and waits for it by polling, resending every 2 seconds until it lands or its blockhash expires.
// Not sendAndConfirmTransaction: it waits over a websocket, and some RPCs (Alchemy's) don't offer signatureSubscribe.
import { type Connection, type Keypair, Transaction, type TransactionInstruction } from "@solana/web3.js"

export async function sendAndWait(conn: Connection, ixs: ReadonlyArray<TransactionInstruction>, signers: readonly [Keypair, ...Array<Keypair>]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed")
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(...ixs)
  tx.sign(...signers)
  const raw = tx.serialize()
  const signature = await conn.sendRawTransaction(raw, { maxRetries: 0 })
  while (await conn.getBlockHeight("confirmed") <= lastValidBlockHeight) {
    const status = (await conn.getSignatureStatuses([signature])).value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature
    await new Promise((r) => setTimeout(r, 2000))
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {})
  }
  throw new Error(`${signature} didn't land before its blockhash expired: run it again`)
}
