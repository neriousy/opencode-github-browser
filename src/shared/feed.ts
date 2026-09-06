import type { Feed } from "./rpc"

/** Ignore old automatic MCP lists, but honor an explicit link open even when its feed kept the old label. */
export function isLegacyMcpFeed(feed: Feed) {
  if (feed.selected && (feed.navigation ?? 0) > 0) return false
  return !feed.search && (feed.note.startsWith("MCP results ·") || feed.note.startsWith("GitHub MCP"))
}
