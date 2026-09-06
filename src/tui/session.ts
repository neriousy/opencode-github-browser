import type { SessionInfo } from "@opencode-ai/client"
import type { BrowserContext } from "./context"
import { GitHub, type Item } from "../shared/rpc"

/** Prepare an idle conversation with durable context, without admitting a prompt or synthetic inbox item. */
export async function createIssueSession(
  client: BrowserContext["client"],
  item: Item,
  location: NonNullable<BrowserContext["location"]>,
  source?: Pick<SessionInfo, "agent" | "model">,
) {
  const session = await client.session.create({
    title: `${item.kind === "pr" ? "PR" : "Issue"} #${item.number} · ${item.title}`,
    location,
    agent: source?.agent,
    model: source?.model,
    metadata: { "github-browser.reference": item.url },
  })
  const pinned = await client.rpc(GitHub).pin({ sessionID: session.id, item }, { location })
  if (item.bodyLoaded) return { session, feed: pinned }
  const result = await client.rpc(GitHub).read({ url: item.url, part: "details" }, { location })
  const feed = await client.rpc(GitHub).saveRead({ sessionID: session.id, result }, { location })
  return { session, feed }
}
