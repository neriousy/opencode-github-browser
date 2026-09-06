import { expect, test } from "bun:test"
import { SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { linkAt, registerLinks } from "../../src/tui/links"

test("rendered GitHub links open internally; selection, unrelated links and cleanup keep host behavior", async () => {
  const opened: string[] = []
  const rendered = await testRender(
    () => (
      <box>
        <text>
          <a href="https://github.com/owner/repo/pull/42/files#diff">Read this PR</a>
        </text>
        <text>
          <a href="https://example.com">Other website</a>
        </text>
      </box>
    ),
    { width: 40, height: 8 },
  )
  const previous = rendered.renderer.root.processMouseEvent
  const stop = registerLinks(rendered.renderer, (url) => {
    opened.push(url)
  })
  try {
    await rendered.renderOnce()
    expect(linkAt(rendered.renderer, 2, 0)).toBe("https://github.com/owner/repo/pull/42")
    expect(linkAt(rendered.renderer, 2, 1)).toBeUndefined()
    await rendered.mockMouse.click(2, 0)
    expect(opened).toEqual(["https://github.com/owner/repo/pull/42"])
    await rendered.mockMouse.drag(1, 0, 8, 0)
    expect(opened).toHaveLength(1)
    stop()
    expect(rendered.renderer.root.processMouseEvent).toBe(previous)
  } finally {
    stop()
    rendered.renderer.destroy()
  }
})

test("Markdown table issue links open from their label and URL", async () => {
  const opened: string[] = []
  const syntax = SyntaxStyle.create()
  const rendered = await testRender(
    () => (
      <markdown
        syntaxStyle={syntax}
        content={
          "| Issue | Summary |\n| --- | --- |\n| [#42](https://github.com/owner/repo/issues/42) | Read this issue |"
        }
      />
    ),
    { width: 100, height: 12 },
  )
  const stop = registerLinks(rendered.renderer, (url) => {
    opened.push(url)
  })
  try {
    await rendered.renderOnce()
    const cells = Array.from({ length: 12 }, (_, y) => Array.from({ length: 100 }, (_, x) => ({ x, y })))
      .flat()
      .filter(({ x, y }) => linkAt(rendered.renderer, x, y))
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of [cells[0], cells.at(-1)]) {
      if (!cell) throw new Error("Missing rendered link")
      await rendered.mockMouse.click(cell.x, cell.y)
    }
    expect(opened).toEqual(Array(2).fill("https://github.com/owner/repo/issues/42"))
  } finally {
    stop()
    rendered.renderer.destroy()
    syntax.destroy()
  }
})
