import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Feed, GitHub } from "../../src/shared/rpc"
import { observe } from "../../src/server/observe"
import { githubURL, reference } from "../../src/shared/url"

const url = "https://github.com/owner/repo/issues/42"
test("portable RPC schemas decode defaults and round-trip persisted feeds", async () => {
  expect(
    await GitHub.methods.search.input["~standard"].validate({ sessionID: "ses_test", query: "  repo:owner/repo  " }),
  ).toMatchObject({
    value: { sessionID: "ses_test", query: "repo:owner/repo", kind: "all", page: 1 },
  })
  const feed = { items: [reference(url)], selected: url, note: "" }
  expect(Schema.decodeUnknownSync(Feed)(JSON.parse(JSON.stringify(Schema.encodeSync(Feed)(feed))))).toEqual(feed)
  expect(await GitHub.methods.current.output["~standard"].validate(feed)).toMatchObject({ value: feed })
  expect(
    await GitHub.events.selected.schema["~standard"].validate({ sessionID: "ses_test", feed, reveal: true }),
  ).toMatchObject({ value: { feed } })
})

test("RPC schemas reject empty search, invalid pages and sessions", async () => {
  const decode = GitHub.methods.search.input["~standard"].validate
  expect((await decode({ sessionID: "bad", query: "x" })).issues).toBeDefined()
  expect((await decode({ sessionID: "ses_test", query: " " })).issues).toBeDefined()
  expect((await decode({ sessionID: "ses_test", query: "x", page: 21 })).issues).toBeDefined()
})

test("MCP envelopes normalize PRs returned by issue search and preserve their cached discussion", () => {
  const old = { ...reference(url), comments: [{ id: "1", author: "reviewer", body: "hello" }], commentsLoaded: true }
  const feed = observe(
    { items: [old], selected: url, note: "" },
    "search_issues",
    {},
    {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: [
              {
                number: 42,
                title: "Fix renderer",
                html_url: url,
                pull_request: {},
                labels: { nodes: [{ name: "bug" }] },
                body: null,
              },
            ],
          }),
        },
      ],
    },
  )
  expect(feed?.items).toHaveLength(1)
  expect(feed?.items[0]).toMatchObject({ kind: "pr", labels: ["bug"], bodyLoaded: true, comments: old.comments })
  expect(feed?.selected).toBe(url.replace("/issues/", "/pull/"))
})

test("search results mark merged PRs without a separate details read", () => {
  const feed = observe(
    null,
    "search_issues",
    { owner: "owner", repo: "repo" },
    {
      output: {
        items: [
          {
            number: 7,
            title: "Merged",
            state: "closed",
            pull_request: { merged_at: "2026-01-01T00:00:00Z" },
            body: "",
          },
          { number: 8, title: "Closed", state: "closed", pull_request: { merged_at: null }, body: "" },
        ],
      },
    },
  )
  expect(feed?.items.map((item) => [item.kind, item.state])).toEqual([
    ["pr", "merged"],
    ["pr", "closed"],
  ])
})

test("comment pages merge by id, refresh replaces removed comments, and malformed envelopes are ignored", () => {
  const feed = { items: [reference(url)], selected: url, note: "" }
  const args = { owner: "owner", repo: "repo", issue_number: 42, method: "get_comments" }
  const first = observe(feed, "issue_read", args, { output: [{ id: 1, body: "first", user: { login: "alice" } }] })
  const second = observe(
    first,
    "issue_read",
    { ...args, page: 2 },
    {
      output: [
        { id: 1, body: "edited" },
        { id: 2, body: null },
      ],
    },
  )
  expect(second?.items[0].comments).toHaveLength(2)
  expect(second?.items[0].comments[0].body).toBe("edited")
  expect(observe(second, "issue_read", args, { output: [] })?.items[0].comments).toEqual([])
  expect(observe(feed, "issue_read", args, { isError: true, output: [] })).toBeNull()
  expect(observe(feed, "issue_read", args, "{broken")).toBeNull()
})

test("GitHub links canonicalize subpages without accepting external URLs", () => {
  expect(githubURL("https://github.com/owner/repo/pull/42/files#diff-abc")?.url).toBe(
    "https://github.com/owner/repo/pull/42",
  )
  expect(githubURL("https://api.github.com/repos/owner/repo/issues/42")?.url).toBe(url)
  expect(githubURL("https://github.com.evil.test/owner/repo/issues/42")).toBeUndefined()
  expect(githubURL("https://user:pass@github.com/owner/repo/issues/42")).toBeUndefined()
})

test("host contracts expose Standard Schema without leaking native Effect ASTs", async () => {
  for (const method of Object.values(GitHub.methods)) {
    for (const schema of [method.input, method.output, ...Object.values(method.errors)]) {
      expect(Schema.isSchema(schema)).toBe(false)
      expect("ast" in schema).toBe(false)
    }
  }
  expect(Schema.isSchema(GitHub.events.selected.schema)).toBe(false)
})
