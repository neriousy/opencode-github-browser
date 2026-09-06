import {
  BoxRenderable,
  ImageRenderable,
  MarkdownRenderable,
  RenderableEvents,
  TextRenderable,
  TextTableRenderable,
  StyledText,
  TextAttributes,
  type SyntaxStyle,
  type MarkdownOptions,
} from "@opentui/core"
import { marked, type Token } from "marked"
import { createEffect, onCleanup } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { Plugin } from "@opencode-ai/plugin/tui"
import { GitHub, errorMessage } from "../shared/rpc"
import { imageURL } from "../shared/image"
import type { BrowserContext } from "./context"
import { imageParts } from "./image-parts"
import { markdownChunks } from "./markdown-text"

export function GitHubMarkdown(props: {
  content: string
  repository: string
  syntax: SyntaxStyle
  context: BrowserContext
  location: Plugin.Context["location"]
}) {
  const renderer = useRenderer()
  const renderNode: NonNullable<MarkdownOptions["renderNode"]> = (token, context) => {
    const children = (tokens: Token[]) => {
      const box = new BoxRenderable(renderer, { width: "100%", flexDirection: "column", flexShrink: 0 })
      for (const child of tokens) {
        if (child.type === "space" || child.type === "checkbox") continue
        const node =
          renderNode(child, context) ??
          new MarkdownRenderable(renderer, {
            content: child.raw,
            syntaxStyle: context.syntaxStyle,
            width: "100%",
            flexShrink: 0,
          })
        if (box.getChildren().length && child.type !== "list") node.marginTop = 1
        node.marginBottom = 0
        if (node instanceof BoxRenderable) node.paddingBottom = 0
        box.add(node)
      }
      return box
    }
    if (token.type === "blockquote") {
      const quote = children(token.tokens ?? [])
      quote.border = ["left"]
      quote.borderColor = props.context.theme.markdown.blockQuote
      quote.paddingLeft = 1
      quote.paddingBottom = 1
      return quote
    }
    if (token.type === "list") {
      const list = new BoxRenderable(renderer, {
        width: "100%",
        flexDirection: "column",
        flexShrink: 0,
        paddingBottom: 1,
      })
      const items: { tokens: Token[]; task: boolean; checked?: boolean }[] = token.items
      const start = Number(token.start) || 1
      const width = token.ordered ? String(start + items.length - 1).length + 2 : 2
      items.forEach((item, index) => {
        const row = new BoxRenderable(renderer, { width: "100%", flexDirection: "row", flexShrink: 0 })
        row.add(
          new TextRenderable(renderer, {
            content: item.task ? (item.checked ? "☑ " : "☐ ") : token.ordered ? `${start + index}. ` : "• ",
            fg: props.context.theme.markdown.listItem,
            width,
            flexShrink: 0,
          }),
        )
        const body = children(item.tokens)
        body.width = "auto"
        body.flexGrow = 1
        body.flexShrink = 1
        row.add(body)
        list.add(row)
      })
      return list
    }
    if (token.type === "table" && !imageParts(token).some((part) => part.type === "image")) {
      const header: { tokens: Token[] }[] = token.header
      const rows: { tokens: Token[] }[][] = token.rows
      return new TextTableRenderable(renderer, {
        width: "100%",
        flexShrink: 0,
        columnWidthMode: "full",
        wrapMode: "word",
        cellPaddingX: 1,
        cellPaddingY: 0,
        showBorders: true,
        borderColor: props.context.theme.markdown.blockQuote,
        selectable: true,
        content: [header, ...rows].map((row, index) =>
          row.map((cell) =>
            markdownChunks(cell.tokens, context.syntaxStyle, props.repository, {
              ...context.syntaxStyle.mergeStyles("default"),
              attributes: index === 0 ? TextAttributes.BOLD : 0,
            }),
          ),
        ),
      })
    }
    const parts = imageParts(token)
    if (!parts.some((part) => part.type === "image")) {
      if (!["paragraph", "text", "heading"].includes(token.type)) return
      const text = new TextRenderable(renderer, {
        content: new StyledText(
          markdownChunks(
            "tokens" in token && token.tokens ? token.tokens : marked.Lexer.lexInline(token.raw),
            context.syntaxStyle,
            props.repository,
            context.syntaxStyle.mergeStyles(token.type === "heading" ? "markup.heading" : "default"),
          ),
        ),
        width: "100%",
        flexShrink: 0,
        wrapMode: "word",
      })
      if (token.type === "heading") return text
      // OpenTUI owns top-level margins; keep paragraph spacing inside the custom block.
      const paragraph = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, paddingBottom: 1 })
      paragraph.add(text)
      return paragraph
    }
    const block = new BoxRenderable(renderer, { width: "100%", flexDirection: "column", gap: 1, flexShrink: 0 })
    for (const part of parts) {
      if (part.type === "markdown") {
        if (part.content.trim())
          block.add(
            new MarkdownRenderable(renderer, {
              content: part.content,
              syntaxStyle: context.syntaxStyle,
              width: "100%",
              flexShrink: 0,
              internalBlockMode: "top-level",
              renderNode,
            }),
          )
        continue
      }
      const attachment = new BoxRenderable(renderer, { width: "100%", flexDirection: "column", flexShrink: 0 })
      const status = new TextRenderable(renderer, {
        content: `Loading image · ${part.alt}`,
        fg: props.context.theme.text.subdued,
        width: "100%",
        wrapMode: "word",
        flexShrink: 0,
      })
      const preview = new ImageRenderable(renderer, {
        width: "100%",
        height: 8,
        flexShrink: 0,
        fit: "fit",
        protocol: "auto",
        onLoad: () => {
          status.content = `${part.alt} · click image to expand`
          size()
        },
        onError: () => failed("No preview for this image."),
        onMouseUp: () => {
          expanded = !expanded
          size()
          status.content = `${part.alt} · click image to ${expanded ? "collapse" : "expand"}`
        },
        onSizeChange: () => size(),
      })
      let expanded = false
      const size = () => {
        if (!preview.image) return
        const maximum = expanded ? Math.max(8, renderer.height - 8) : 12
        const height = Math.max(
          3,
          Math.min(
            maximum,
            Math.ceil((preview.width * preview.image.height) / preview.image.width / preview.cellAspectRatio),
          ),
        )
        if (preview.height !== height) preview.height = height
      }
      const failed = (message: string) => {
        preview.visible = false
        status.content = `${part.alt} · ${message} Click to retry.`
        status.fg = props.context.theme.text.subdued
      }
      const controller = new AbortController()
      let loading = false
      const load = async () => {
        if (loading || controller.signal.aborted) return
        const url = imageURL(part.url)
        if (!url) {
          preview.visible = false
          status.content = `${part.alt} · Preview unavailable for this source (${part.url})`
          return
        }
        loading = true
        preview.visible = true
        status.content = `Loading image · ${part.alt}`
        try {
          const result = await props.context.client
            .rpc(GitHub)
            .image({ url }, { location: props.location, signal: controller.signal })
          if (!controller.signal.aborted)
            preview.source = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0))
        } catch (error) {
          if (!controller.signal.aborted) failed(errorMessage(error))
        } finally {
          loading = false
        }
      }
      status.onMouseUp = () => {
        if (!preview.visible) void load()
      }
      attachment.on(RenderableEvents.DESTROYED, () => controller.abort())
      attachment.add(preview)
      attachment.add(status)
      block.add(attachment)
      void load()
    }
    return block
  }
  // Set syntax in the constructor: a first-frame style reset would discard custom image nodes.
  const markdown = new MarkdownRenderable(renderer, {
    syntaxStyle: props.syntax,
    content: props.content,
    internalBlockMode: "top-level",
    width: "100%",
    flexShrink: 0,
    renderNode,
  })
  createEffect(() => {
    markdown.syntaxStyle = props.syntax
    markdown.content = props.content
  })
  onCleanup(() => markdown.destroyRecursively())
  return <box width="100%" flexShrink={0} ref={(box) => box.add(markdown)} />
}
