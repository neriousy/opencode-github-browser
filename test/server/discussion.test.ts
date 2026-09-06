import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Session } from "@opencode-ai/schema/session"
import { discussionContext } from "../../src/server/discussion"
import { FeedStorage, FeedStore } from "../../src/server/store"
import { reference } from "../../src/shared/url"
import { testEffect } from "../helpers"
import { detailFeed, searchFeed } from "../fixtures"

const layer = FeedStore.layer.pipe(
  Layer.provide(
    Layer.sync(FeedStorage)(() => {
      const values = new Map<string, Schema.Json>()
      return {
        get: (key) => Effect.sync(() => values.get(key)),
        set: (key, value) =>
          Effect.sync(() => {
            values.set(key, value)
          }),
      }
    }),
  ),
)
const it = testEffect(layer)
const sessionID = Session.ID.make("ses_item")
const item = {
  ...reference("https://github.com/owner/repo/pull/42"),
  body: "Long GitHub description. ".repeat(600),
  bodyLoaded: true,
}
const session = (metadata: Record<string, Schema.Json> = {}) => ({
  get: () =>
    Effect.succeed(
      Schema.decodeUnknownSync(Session.Info)({
        id: sessionID,
        projectID: "fixture",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 0, updated: 0 },
        location: { directory: "/fixture" },
        metadata,
      }),
    ),
})

it("conversation context survives browsing away, uses fresh comments, and resolves issue URLs to PRs", () =>
  Effect.gen(function* () {
    const store = yield* FeedStore
    const source = session({ "github-browser.reference": item.url.replace("/pull/", "/issues/") })
    yield* store.update(sessionID, () => detailFeed(item), { pin: item })
    const first = yield* discussionContext(source, sessionID)
    expect(first).toContain(item.body)
    expect(first).toContain(item.url)

    yield* store.update(sessionID, () =>
      detailFeed({
        ...item,
        comments: [{ id: "1", author: "reviewer", body: "New discussion comment" }],
        commentsLoaded: true,
      }),
    )
    yield* store.update(sessionID, () =>
      searchFeed([reference("https://github.com/other/project/issues/1")], { query: "repo:other/project is:open" }),
    )
    const before = yield* store.current(sessionID)
    const next = yield* discussionContext(source, sessionID)
    expect(next).toContain("New discussion comment")
    expect(next).toContain(item.body)
    expect(next).not.toContain("other/project")
    expect(yield* store.current(sessionID)).toEqual(before)
  }))

it("ordinary browser sessions never inject context, and pinned context is isolated by session", () =>
  Effect.gen(function* () {
    const store = yield* FeedStore
    yield* store.update(sessionID, () => detailFeed(item), { pin: item })
    expect(yield* discussionContext(session(), sessionID)).toBeUndefined()
    expect(yield* discussionContext(session({ "github-browser.reference": 42 }), sessionID)).toBeUndefined()
    const other = yield* discussionContext(
      session({ "github-browser.reference": item.url }),
      Session.ID.make("ses_other"),
    )
    expect(other).toContain(item.url)
    expect(other).not.toContain(item.body)
  }))
