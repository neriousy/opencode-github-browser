import { TextAttributes, type SyntaxStyle, type TextChunk } from "@opentui/core"
import { marked, type Token } from "marked"
import { githubURL } from "../shared/url"
import { entity } from "./image-parts"

type Style = Omit<TextChunk, "__isChunk" | "text">

/** Render parsed inline tokens rather than exposing Markdown syntax or repeating link destinations. */
export function markdownChunks(
  tokens: Token[],
  syntax: SyntaxStyle,
  repository: string,
  inherited: Style = syntax.mergeStyles("default"),
): TextChunk[] {
  const styled = (name: string, attributes = 0): Style => {
    const style = syntax.mergeStyles(name)
    return { ...inherited, ...style, attributes: (inherited.attributes ?? 0) | style.attributes | attributes }
  }
  const chunk = (text: string, style = inherited): TextChunk => ({ __isChunk: true, text: entity(text), ...style })
  return tokens.flatMap((token): TextChunk[] => {
    if (token.type === "image" || token.type === "code" || token.type === "checkbox") return []
    if (token.type === "br") return [chunk("\n")]
    if (token.type === "escape") return [chunk(token.text)]
    if (token.type === "codespan") return [{ __isChunk: true, text: token.text, ...styled("markup.raw") }]
    if (token.type === "strong")
      return markdownChunks(token.tokens ?? [], syntax, repository, styled("markup.strong", TextAttributes.BOLD))
    if (token.type === "em")
      return markdownChunks(token.tokens ?? [], syntax, repository, styled("markup.italic", TextAttributes.ITALIC))
    if (token.type === "del")
      return markdownChunks(token.tokens ?? [], syntax, repository, styled("default", TextAttributes.STRIKETHROUGH))
    if (token.type === "link") {
      const href = entity(token.href)
      const style = { ...styled("markup.link"), link: { url: href } }
      if (entity(token.text) === href) return [chunk(linkLabel(href, repository), style)]
      return markdownChunks(token.tokens ?? [], syntax, repository, style)
    }
    if (token.type === "html") {
      if (/^<br\s*\/?\s*>$/i.test(token.raw)) return [chunk("\n")]
      if (/^<!--[\s\S]*-->$/.test(token.raw)) return []
      return [chunk(token.raw)]
    }
    if ("tokens" in token && token.tokens) return markdownChunks(token.tokens, syntax, repository, inherited)
    if (token.type !== "text") return []
    const text: string = token.text
    if (inherited.link) return [chunk(text)]
    const matches = [...text.matchAll(/(?<![\w/@\\#])(?:([\w.-]+\/[\w.-]+))?#([1-9]\d*)(?![\w])/g)]
    const result: TextChunk[] = []
    let offset = 0
    for (const match of matches) {
      const url = githubURL(`https://github.com/${match[1] || repository}/issues/${match[2]}`)
      if (!url) continue
      result.push(chunk(text.slice(offset, match.index)))
      result.push(chunk(match[0], { ...styled("markup.link"), link: { url: url.url } }))
      offset = match.index + match[0].length
    }
    result.push(chunk(text.slice(offset)))
    return result
  })
}

function linkLabel(href: string, repository: string) {
  const item = githubURL(href)
  if (item) return `${item.repository === repository ? "" : item.repository}#${item.number}`
  if (!URL.canParse(href)) return href
  const url = new URL(href)
  const label = `${url.host}${url.pathname === "/" ? "" : url.pathname}` || href
  return label.length > 60 ? `${label.slice(0, 57)}…` : label
}

/** The keyboard picker uses the same links as the reader, excluding code and image destinations. */
export function markdownReferences(contents: string[], repository: string, syntax: SyntaxStyle) {
  const urls = new Map<string, { title: string; url: string; repository: string; number: number }>()
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === "code" || token.type === "codespan" || token.type === "image") continue
      if (token.type === "blockquote") {
        visit(token.tokens ?? [])
        continue
      }
      if (token.type === "list") {
        token.items.forEach((item: { tokens: Token[] }) => visit(item.tokens))
        continue
      }
      if (token.type === "table") {
        const cells: { tokens: Token[] }[] = [...token.header, ...token.rows.flat()]
        cells.forEach((cell) => visit(cell.tokens))
        continue
      }
      for (const chunk of markdownChunks([token], syntax, repository)) {
        const item = chunk.link && githubURL(chunk.link.url)
        if (item) urls.set(`${item.repository}#${item.number}`, { ...item, title: linkLabel(item.url, repository) })
      }
    }
  }
  contents.forEach((content) => visit(marked.lexer(content)))
  return [...urls.values()]
}
