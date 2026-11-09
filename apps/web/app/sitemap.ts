import { siteUrl } from "@/lib/site"
import type { MetadataRoute } from "next"

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/shop", "/fair"].map((path) => ({ url: `${siteUrl}${path}`, changeFrequency: "weekly" }))
}
