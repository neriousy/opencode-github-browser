import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { FeedStorage, FeedStore } from "../../src/server/store"
import { ViewError } from "../../src/server/errors"
import type { Feed } from "../../src/shared/rpc"
import { reference } from "../../src/shared/url"
import { testEffect } from "../helpers"

function storage() {
  const values = new Map<string, Schema.Json>()
  return {
    values,
    get: (key: string) => Effect.sync(() => values.get(key)),
    set: (key: string, value: Schema.Json) =>
      Effect.sync(() => {
        values.set(key, Schema.decodeUnknownSync(Schema.Json)(value))
      }),
  }
}
const layer = FeedStore.layer.pipe(Layer.provide(Layer.sync(FeedStorage)(storage)))
const it = testEffect(layer)
const item = reference("https://github.com/owner/repo/issues/1")
const initial = { items: [item], selected: item.url, note: "" }

testEffect(Layer.empty)("old MCP lists do not restore or merge into explicit browser navigation", () =>
  Effect.gen(function* () {
    const data = storage()
    data.values.set("view/ses_mcp", {
      feed: { ...initial, note: "MCP results · is:open", revision: 17 },
      cache: [item],
      observed: [item],
    })
    const services = yield* Layer.build(FeedStore.layer.pipe(Layer.provide(Layer.succeed(FeedStorage)(data))))
    const store = yield* Effect.service(FeedStore).pipe(Effect.provideContext(services))
    expect(yield* store.current("ses_mcp")).toBeNull()
    expect(yield* store.reference("ses_mcp", item.url)).toEqual(item)
    const opened = reference("https://github.com/owner/repo/issues/99")
    const next = yield* store.update(
      "ses_mcp",
      ({ feed }) => {
        expect(feed).toBeNull()
        return { items: [opened], selected: opened.url, note: "GitHub" }
      },
      true,
    )
    expect(next?.items).toEqual([opened])
    expect(next?.revision).toBe(18)
    expect(next?.navigation).toBe(18)
    expect(yield* store.current("ses_mcp")).toEqual(next)
  }),
)

testEffect(Layer.empty)("existing repository searches and explicit pins still restore", () =>
  Effect.gen(function* () {
    const data = storage()
    const feed: Feed = {
      ...initial,
      search: { query: "repo:owner/repo is:open", kind: "issue", page: 2, total: 342, incomplete: false },
      shortlist: { items: [item], note: "MCP results · bug" },
      revision: 12,
    }
    const pinned = { ...initial, note: "Pinned GitHub reference" }
    data.values.set("view/ses_search", { feed, cache: [item], observed: [item] })
    data.values.set("view/ses_pin", { feed: pinned, cache: [item] })
    const services = yield* Layer.build(FeedStore.layer.pipe(Layer.provide(Layer.succeed(FeedStorage)(data))))
    const store = yield* Effect.service(FeedStore).pipe(Effect.provideContext(services))
    expect(yield* store.current("ses_search")).toEqual(feed)
    expect(yield* store.current("ses_pin")).toEqual(pinned)
    const next = yield* store.update("ses_search", () => ({ ...initial, search: feed.search }))
    expect(next?.shortlist).toBeUndefined()
    expect(next?.revision).toBe(13)
  }),
)

it("serializes concurrent writers without losing cached items or revisions", () =>
  Effect.gen(function* () {
    const store = yield* FeedStore
    yield* Effect.forEach(
      Array.from({ length: 40 }, (_, n) => n + 1),
      (n) =>
        store.update("ses_one", ({ feed }) => ({
          ...initial,
          items: [...(feed?.items ?? []), reference(`https://github.com/owner/repo/issues/${n}`)],
        })),
      { concurrency: "unbounded" },
    )
    const result = yield* store.current("ses_one")
    expect(result?.items.length).toBe(40)
    expect(result?.revision).toBe(40)
    yield* store.update(
      "ses_one",
      ({ cache }) => {
        expect(cache.length).toBe(40)
        return { ...initial, items: [cache[20]] }
      },
      true,
    )
    yield* store.update("ses_one", ({ cache }) => {
      expect(cache.length).toBe(40)
      return { ...initial, items: [cache[30]] }
    })
    expect((yield* store.current("ses_one"))?.navigation).toBe(41)
  }))

it("a failed change does not poison the next writer", () =>
  Effect.gen(function* () {
    const store = yield* FeedStore
    const error = yield* store
      .update("ses_one", () => new ViewError({ message: "invalid selection" }))
      .pipe(Effect.flip)
    expect(error.message).toBe("invalid selection")
    yield* store.update("ses_one", () => initial)
    expect((yield* store.current("ses_one"))?.revision).toBe(1)
    expect(yield* store.update("ses_one", () => null)).toBeNull()
    expect((yield* store.current("ses_one"))?.revision).toBe(1)
  }))

const legacy = storage()
legacy.values.set("session/ses_legacy", initial)
testEffect(FeedStore.layer.pipe(Layer.provide(Layer.succeed(FeedStorage)(legacy))))(
  "restores legacy storage and migrates it on the next write",
  () =>
    Effect.gen(function* () {
      const store = yield* FeedStore
      expect((yield* store.current("ses_legacy"))?.selected).toBe(item.url)
      yield* store.update("ses_legacy", ({ cache }) => ({ ...initial, items: cache }))
      expect(legacy.values.has("view/ses_legacy")).toBe(true)
    }),
)

testEffect(Layer.empty)("cancels a queued writer, releases its lock, and keeps other sessions independent", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const data = storage()
    const services = yield* Layer.build(
      FeedStore.layer.pipe(
        Layer.provide(
          Layer.succeed(FeedStorage)({
            ...data,
            get: (key) =>
              key === "view/ses_blocked"
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(data.get(key)),
                  )
                : data.get(key),
          }),
        ),
      ),
    )
    const store = yield* Effect.service(FeedStore).pipe(Effect.provideContext(services))
    const first = yield* store.update("ses_blocked", () => initial).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    const queued = yield* store.update("ses_blocked", () => ({ ...initial, note: "cancelled" })).pipe(Effect.forkChild)
    yield* store.update("ses_other", () => initial)
    expect((yield* store.current("ses_other"))?.revision).toBe(1)
    yield* Fiber.interrupt(queued)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* store.update("ses_blocked", () => ({ ...initial, note: "after cancellation" }))
    expect((yield* store.current("ses_blocked"))?.revision).toBe(2)
  }),
)
