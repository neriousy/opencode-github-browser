import { marked, type Token } from "marked"

type Part = { type: "markdown"; content: string } | { type: "image"; url: string; alt: string }

function occurrences(text: string, value: string) {
  if (!value) return []
  return [...text.matchAll(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((match) => ({
    start: match.index,
    end: match.index + value.length,
  }))
}

export function entity(value: string) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (value) => {
    if (value.startsWith("&#")) {
      const number = Number.parseInt(
        value.slice(value[2].toLowerCase() === "x" ? 3 : 2, -1),
        value[2].toLowerCase() === "x" ? 16 : 10,
      )
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : value
    }
    return { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" }[value.toLowerCase()] ?? value
  })
}

/** Use parsed Markdown tokens so examples in fenced/inline code never become network requests. */
export function imageParts(token: Token): Part[] {
  const images: { raw: string; url: string; alt: string }[] = []
  const code: string[] = []
  marked.walkTokens([token], (child) => {
    if (child.type === "code" || child.type === "codespan") code.push(child.raw)
    if (child.type === "image")
      images.push({ raw: child.raw, url: entity(child.href), alt: entity(child.text || "Image") })
    if (child.type !== "html") return
    for (const match of child.raw.matchAll(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
      const attributes = new Map(
        [...match[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((attribute) => [
          attribute[1].toLowerCase(),
          entity(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""),
        ]),
      )
      const url = attributes.get("src")
      if (url) images.push({ raw: match[0], url, alt: attributes.get("alt") || "Image" })
    }
  })
  const protectedRanges = code.flatMap((raw) => occurrences(token.raw, raw))
  const matches = images
    .flatMap((image) =>
      occurrences(token.raw, image.raw)
        .filter((range) => !protectedRanges.some((code) => range.start >= code.start && range.start < code.end))
        .map((range) => ({ ...range, image })),
    )
    .sort((a, b) => a.start - b.start)
  const result: Part[] = []
  let offset = 0
  for (const match of matches) {
    if (match.start < offset) continue
    if (match.start > offset) result.push({ type: "markdown", content: token.raw.slice(offset, match.start) })
    result.push({ type: "image", url: match.image.url, alt: match.image.alt })
    offset = match.end
  }
  if (offset < token.raw.length) result.push({ type: "markdown", content: token.raw.slice(offset) })
  return result
}
