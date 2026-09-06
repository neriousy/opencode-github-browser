import stringWidth from "string-width"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Fit terminal cells, preserving emoji/combining characters and marking omitted text. */
export function ellipsis(value: string, width: number) {
  const text = value.replace(/\s+/g, " ").trim()
  if (width <= 0) return ""
  if (stringWidth(text) <= width) return text
  let used = 0
  let result = ""
  for (const { segment } of graphemes.segment(text)) {
    const size = stringWidth(segment)
    if (used + size > width - 1) break
    result += segment
    used += size
  }
  return `${result}…`
}
