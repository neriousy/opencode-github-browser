import { expect, test } from "bun:test"
import { isLegacyMcpFeed } from "../../src/shared/feed"
import { reference } from "../../src/shared/url"

const item = reference("https://github.com/owner/repo/issues/42")

for (const note of ["GitHub MCP", "GitHub MCP · issues", "MCP results · label:bug"]) {
  test(`explicit opens take precedence over the old ${note} label`, () => {
    const feed = { items: [item], selected: item.url, note }
    expect(isLegacyMcpFeed(feed)).toBe(true)
    expect(isLegacyMcpFeed({ ...feed, navigation: 0, revision: 10 })).toBe(true)
    expect(isLegacyMcpFeed({ ...feed, navigation: 10, revision: 10 })).toBe(false)
    expect(isLegacyMcpFeed({ ...feed, navigation: 10, revision: 11 })).toBe(false)
    expect(isLegacyMcpFeed({ ...feed, selected: null, navigation: 10 })).toBe(true)
  })
}
