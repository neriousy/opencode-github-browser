import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FeedStorage, FeedStore } from "../../src/server/store"
import { openView, readView, searchView } from "../../src/server/view"
import { reference } from "../../src/shared/url"
import { testEffect } from "../helpers"
import { searchFeed } from "../fixtures"

const item = { ...reference("https://github.com/owner/repo/issues/42"), title: "Issue", body: "Old", bodyLoaded: true }
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

testEffect(layer)("independent read saves preserve navigation and other parts while refreshing pinned context", () =>
  Effect.gen(function* () {
    const store = yield* FeedStore
    yield* store.update("ses_item", (snapshot) => openView(snapshot, item), {
      pin: item,
      reveal: true,
    })
    yield* Effect.all(
      [
        store.update("ses_item", (snapshot) =>
          readView(snapshot, {
            part: "comments",
            url: item.url,
            comments: [{ id: "1", author: "alice", body: "New comment" }],
          }),
        ),
        store.update("ses_item", (snapshot) =>
          readView(snapshot, {
            part: "details",
            item: { ...item, url: item.url.replace("/issues/", "/pull/"), kind: "pr", body: "Fresh" },
          }),
        ),
      ],
      { concurrency: "unbounded" },
    )
    const feed = yield* store.current("ses_item")
    expect(feed?.navigation).toBe(1)
    expect(feed?.revision).toBe(3)
    expect(feed?.selected).toBe(item.url.replace("/issues/", "/pull/"))
    expect(feed?.items).toEqual([])
    expect(feed?.detail).toMatchObject({ body: "Fresh", commentsLoaded: true, comments: [{ body: "New comment" }] })
    expect(yield* store.reference("ses_item", item.url)).toEqual(feed?.detail)
    yield* store.update("ses_item", (snapshot) => readView(snapshot, { part: "comments", url: item.url, comments: [] }))
    expect((yield* store.reference("ses_item", item.url))?.comments).toEqual([])
  }),
)

testEffect(layer)("opening and reading a reference outside a search never adds it to the search results", () =>
  Effect.gen(function* () {
    const store = yield* FeedStore
    const rows = Array.from({ length: 50 }, (_, index) =>
      reference(`https://github.com/owner/repo/issues/${100 + index}`),
    )
    const list = yield* store.update(
      "ses_list",
      (snapshot) =>
        searchView(
          snapshot,
          [
            {
              items: rows,
              query: "repo:owner/repo label:bug",
              kind: "issue",
              page: 1,
              total: 500,
              incomplete: false,
            },
          ],
          "label:bug",
        ),
      { reveal: true },
    )
    const opened = yield* store.update("ses_list", (snapshot) => openView(snapshot, item), { reveal: true })
    expect(opened?.items).toEqual(rows)
    expect(opened?.search).toEqual(list?.search)
    expect(opened?.detail).toEqual(item)
    const loaded = yield* store.update("ses_list", (snapshot) =>
      readView(snapshot, {
        part: "comments",
        url: item.url,
        comments: [{ id: "1", body: "Discussion", author: "alice" }],
      }),
    )
    expect(loaded?.items).toEqual(rows)
    expect(loaded?.detail?.commentsLoaded).toBe(true)
    expect(loaded?.navigation).toBe(opened?.navigation)
  }),
)

testEffect(layer)("a malformed page sequence cannot overwrite the saved search or advance its revision", () =>
  Effect.gen(function* () {
    const store = yield* FeedStore
    const initial = yield* store.update("ses_item", () => searchFeed([item]))
    const error = yield* store
      .update("ses_item", (snapshot) =>
        searchView(
          snapshot,
          [{ items: [], query: "repo:other/repo", kind: "issue", page: 2, total: 100, incomplete: false }],
          "is:open",
        ),
      )
      .pipe(Effect.flip)
    expect(error.message).toContain("search changed")
    expect(yield* store.current("ses_item")).toEqual(initial)
  }),
)
