import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import { createIssueSession } from "../../src/tui/session"
import { reference } from "../../src/shared/url"

const location = { directory: "/fixture/worktree", workspaceID: "workspace_fixture" }
const item = {
  ...reference("https://github.com/owner/repo/issues/42"),
  title: "Renderer bug",
  body: "Full description",
  bodyLoaded: true,
}

for (const loaded of [true, false]) {
  test(`opening a ${loaded ? "loaded issue" : "bare reference"} creates idle context with the source agent/model`, async () => {
    const requests: { path: string; input: unknown }[] = []
    const source = { agent: "plan", model: { providerID: "fixture", id: "reasoner", variant: "high" } }
    const client = OpenCode.make({
      baseUrl: "http://fixture.invalid",
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const request = new Request(input, init)
          const path = new URL(request.url).pathname
          requests.push({ path, input: await request.json() })
          if (path === "/api/session")
            return Response.json({
              data: {
                id: "ses_item",
                projectID: "fixture",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 0, updated: 0 },
                location,
                ...source,
              },
            })
          if (path.endsWith("/read")) return Response.json({ output: { part: "details", item } })
          if (path.endsWith("/pin") || path.endsWith("/saveRead"))
            return Response.json({ output: { items: [item], selected: item.url, note: "" } })
          throw new Error(`Unexpected request: ${path}`)
        },
        { preconnect: () => {} },
      ),
    })
    const result = await createIssueSession(client, loaded ? item : reference(item.url), location, source)
    expect(requests[0]).toEqual({
      path: "/api/session",
      input: {
        title: loaded ? "Issue #42 · Renderer bug" : "Issue #42 · Issue #42",
        location,
        ...source,
        metadata: { "github-browser.reference": item.url },
      },
    })
    expect(requests.map((request) => request.path.split("/").at(-1))).toEqual(
      loaded ? ["session", "pin"] : ["session", "pin", "read", "saveRead"],
    )
    expect(result.feed.items[0].body).toBe(item.body)
    expect(result.session.model).toEqual(source.model)
    // No prompt, synthetic, agent/model-switch or generation endpoints are called before the user types.
    expect(requests).toHaveLength(loaded ? 2 : 4)
  })
}
