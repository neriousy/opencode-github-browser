import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Feed, GitHub } from "../../src/shared/rpc"
import { githubURL, reference } from "../../src/shared/url"

const url = "https://github.com/owner/repo/issues/42"
test("portable RPC schemas decode defaults and round-trip persisted feeds", async () => {
  expect(await GitHub.methods.search.input["~standard"].validate({ query: "  repo:owner/repo  " })).toMatchObject({
    value: { query: "repo:owner/repo", kind: "all", page: 1 },
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
  expect((await GitHub.methods.current.input["~standard"].validate({ sessionID: "bad" })).issues).toBeDefined()
  expect((await decode({ query: " " })).issues).toBeDefined()
  expect((await decode({ query: "x", page: 21 })).issues).toBeDefined()
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
