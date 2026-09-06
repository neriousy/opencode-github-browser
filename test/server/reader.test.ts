import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { GhCommand, GitHubClient } from "../../src/server/github"
import { Reader } from "../../src/server/reader"
import { testEffect } from "../helpers"

const source = {
  html_url: "https://github.com/owner/repo/issues/42",
  title: "Fix renderer",
  state: "closed",
  user: { login: "alice" },
  labels: [{ name: "bug" }],
  body: null,
  pull_request: { merged_at: "2026-01-01T00:00:00Z" },
}
const layer = (output: unknown) =>
  Reader.layer.pipe(
    Layer.provide(GitHubClient.layer),
    Layer.provide(Layer.succeed(GhCommand)({ run: () => Effect.succeed(JSON.stringify(output)) })),
  )

testEffect(layer({ items: [source], total_count: 1, incomplete_results: false }))(
  "search normalizes REST results, canonical PR URLs, merged state, and null descriptions",
  () =>
    Effect.gen(function* () {
      const reader = yield* Reader
      const result = yield* reader.search("repo:owner/repo", "pr", 1, "/fixture")
      expect(result).toMatchObject({ query: "repo:owner/repo", kind: "pr", page: 1, total: 1 })
      expect(result.items[0]).toMatchObject({
        url: "https://github.com/owner/repo/pull/42",
        kind: "pr",
        state: "merged",
        body: "",
        bodyLoaded: true,
        author: "alice",
        labels: ["bug"],
        commentsLoaded: false,
        files: null,
      })
    }),
)

testEffect(layer([[{ id: 1, body: "Comment", user: null }], [{ id: 2, body: null, user: { login: "alice" } }]]))(
  "discussion reads combine REST pages into an independent resource",
  () =>
    Effect.gen(function* () {
      const reader = yield* Reader
      expect(yield* reader.read(source.html_url, "comments")).toEqual({
        part: "comments",
        url: source.html_url,
        comments: [
          { id: "1", body: "Comment", author: "ghost" },
          { id: "2", body: "", author: "alice" },
        ],
      })
    }),
)

testEffect(layer({ ...source, html_url: "https://example.com/issues/42" }))(
  "invalid REST data fails at the reader boundary",
  () =>
    Effect.gen(function* () {
      const reader = yield* Reader
      const error = yield* reader.read(source.html_url, "details").pipe(Effect.flip)
      expect(error._tag).toBe("ViewError")
      expect(error.message).toContain("unexpected item details")
    }),
)
