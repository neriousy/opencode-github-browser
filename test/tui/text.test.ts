import { expect, test } from "bun:test"
import stringWidth from "string-width"
import { ellipsis } from "../../src/tui/text"

test("ellipsis fits terminal columns and preserves complete graphemes", () => {
  expect(ellipsis("short", 10)).toBe("short")
  expect(ellipsis("a long title", 7)).toBe("a long…")
  expect(ellipsis("emoji 👨‍👩‍👧‍👦 text", 9)).toBe("emoji 👨‍👩‍👧‍👦…")
  for (const width of [0, 1, 2, 7, 15]) {
    expect(stringWidth(ellipsis("中文 👨‍👩‍👧‍👦 café with more text", width))).toBeLessThanOrEqual(width)
  }
})
