"use client"

import { productImage } from "@/lib/format"
import { keyPalette } from "@/lib/palette"
import { cn } from "cn"
import { useState } from "react"

interface CardLook {
  name: string
  image?: string | undefined
  background?: string | undefined
}

/**
 * A gift card drawn as a voucher: the brand's logo on its colour, with the two notches of a ticket
 * stub. Cards without a logo, or whose logo won't load, get a tile in a colour of their own.
 */
export function GiftCard({ v, className, notch = 11 }: { v: CardLook; className?: string; notch?: number }) {
  const p = keyPalette(v.name)
  // A logo Bitrefill's image server can't deliver gets the lettered tile, never an empty one.
  const [broken, setBroken] = useState(false)
  const image = broken ? undefined : v.image
  return (
    <span
      className={cn("voucher relative block aspect-[1.6] overflow-hidden rounded-[1.25rem]", className)}
      style={{ background: image ? v.background ?? "#fff" : p.tile, ["--notch" as string]: `${notch}px` }}
    >
      {image
        ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={productImage(image, v.background, 240)} alt="" loading="lazy" onError={() => setBroken(true)} className="absolute inset-0 m-auto h-full object-contain" />
        )
        : (
          <span className="font-display absolute inset-0 grid place-items-center text-[2.6em] font-extrabold" style={{ color: p.ink }} aria-hidden="true">
            {v.name.trim()[0]?.toUpperCase()}
          </span>
        )}
      <span className="pointer-events-none absolute inset-0 bg-[linear-gradient(155deg,rgb(255_255_255/0.35),transparent_45%)]" aria-hidden="true" />
    </span>
  )
}
