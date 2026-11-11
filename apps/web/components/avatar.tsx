import { keyPalette, orbVars } from "@/lib/palette"
import { cn } from "cn"

/** A glossy orb in a colour that belongs to this account. */
export function Avatar({ id, size = 32, className }: { id: string; size?: number; className?: string }) {
  return <span aria-hidden="true" className={cn("orb inline-block", className)} style={{ ...orbVars(keyPalette(id)), width: size, height: size }} />
}

/** "alice.near" stays; implicit 64-hex accounts and EVM addresses shorten to their ends. */
export const shortAccount = (id: string) =>
  /^[0-9a-f]{64}$/.test(id) ? `${id.slice(0, 6)}…${id.slice(-4)}` : /^0x[0-9a-f]{40}$/.test(id) ? `${id.slice(0, 6)}…${id.slice(-4)}` : id
