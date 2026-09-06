import { expect, test } from "bun:test"
import { marked } from "marked"
import { imageParts } from "../../src/tui/image-parts"

test("Markdown and GitHub HTML images render in order without treating code examples as images", () => {
  const markdown = "![" + "Screenshot](https://github.com/user-attachments/assets/one)"
  const html =
    '<img width="1292" height="822" alt="TUI &amp; panel" src="https://github.com/user-attachments/assets/two" />'
  const content = `Before\n\n${markdown}\n\n${html}\n\nAfter\n\n\`${html}\`\n\n\`\`\`html\n${html}\n\`\`\``
  const parts = marked.lexer(content).flatMap(imageParts)
  expect(parts.filter((part) => part.type === "image")).toEqual([
    { type: "image", url: "https://github.com/user-attachments/assets/one", alt: "Screenshot" },
    { type: "image", url: "https://github.com/user-attachments/assets/two", alt: "TUI & panel" },
  ])
  const text = parts
    .filter((part) => part.type === "markdown")
    .map((part) => part.content)
    .join("")
  expect(text).toContain("Before")
  expect(text).toContain("After")
  expect(text).toContain(`\`${html}\``)
  expect(text).toContain(`\`\`\`html\n${html}`)
})

test("reference-style, adjacent and inline HTML images preserve surrounding text", () => {
  const parts = marked
    .lexer(
      'Before ![one][a] <img src="https://github.com/assets/two?x=1&amp;y=2" alt="two > one"> after\n\n[a]: https://github.com/assets/one',
    )
    .flatMap(imageParts)
  expect(parts.filter((part) => part.type === "image").map((part) => part.url)).toEqual([
    "https://github.com/assets/one",
    "https://github.com/assets/two?x=1&y=2",
  ])
  expect(parts[0]).toEqual({ type: "markdown", content: "Before " })
  expect(parts.some((part) => part.type === "markdown" && part.content.trim() === "after")).toBe(true)
})
