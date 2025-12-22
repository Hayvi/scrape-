// Shared parsing helpers

export function decodeEntities(s: string): string {
  // Minimal HTML entity decoding for our use-case
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
}

export function normalizeOutcomeLabel(label: string): string {
  const t = decodeEntities(label).trim()
  if (/^plus$/i.test(t) || /^over$/i.test(t)) return "Over"
  if (/^moins$/i.test(t) || /^under$/i.test(t)) return "Under"
  if (/^oui$/i.test(t) || /^yes$/i.test(t)) return "Yes"
  if (/^non$/i.test(t) || /^no$/i.test(t)) return "No"
  return t
}

export function slugify(input: string): string {
  return decodeEntities(input)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function mapMarketKey(name: string): string {
  const n = decodeEntities(name).toLowerCase()
  if (n.includes("1x2")) return "1x2"
  if (n.includes("double chance")) return "double_chance"
  if (n.includes("les deux") || n.includes("both")) return "btts"
  if (n.includes("total") || n.includes("under / over") || n.includes("under/over")) return "totals"
  if (n.includes("mt/r.fin") || n.includes("mt/r.fin")) return "ht_ft"
  if (n.includes("score exact")) return "correct_score"
  return slugify(n).replace(/[^a-z0-9_-]/g, "-") || "other"
}

export function parseDecimal(fr: string): number {
  const cleaned = fr.trim().replace(/[^0-9,\.\-]/g, "")
  if (cleaned.includes(",") && !cleaned.includes(".")) {
    return Number(cleaned.replace(/\./g, "").replace(/,/g, "."))
  }
  return Number(cleaned.replace(/,/g, ""))
}

export function extractAttr(tag: string, name: string): string | null {
  const re = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)')`, "i")
  const m = tag.match(re)
  return m ? (m[1] ?? m[2] ?? null) : null
}

export function getSelectedSportIdFromNav(html: string): string | null {
  const navMatch = html.match(/<nav[^>]*id=["']main_nav["'][^>]*>[\s\S]*?<\/nav>/i)
  const scope = navMatch ? navMatch[0] : html
  const m = scope.match(/<a[^>]*class=["'][^"']*sport_item[^"']*selected[^"']*["'][^>]*data-sportid=["'](\d+)["'][^>]*>/i)
  return m ? m[1] : null
}
