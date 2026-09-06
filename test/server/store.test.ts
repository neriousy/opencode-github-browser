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

testEffect(Layer.empty)("existing repository searches and explicit pins still restore", () =>
  Effect.gen(function* () {
    const data = storage()
    const feed: Feed = {
      ...initial,
      search: { query: "repo:owner/repo is:open", kind: "issue", page: 2, total: 342, incomplete: false },
      revision: 12,
    }
    const pinned = { ...initial, note: "Pinned GitHub reference" }
    data.values.set("browser.v2/ses_search", { feed, pinned: null })
    data.values.set("browser.v2/ses_pin", { feed: pinned, pinned: item })
    const services = yield* Layer.build(FeedStore.layer.pipe(Layer.provide(Layer.succeed(FeedStorage)(data))))
    const store = yield* Effect.service(FeedStore).pipe(Effect.provideContext(services))
    expect(yield* store.current("ses_search")).toEqual(feed)
    expect(yield* store.current("ses_pin")).toEqual(pinned)
    const next = yield* store.update("ses_search", () => ({ ...initial, search: feed.search }))
    expect(next?.revision).toBe(13)
  }),
)

it("serializes concurrent view updates and preserves an explicit pin without archiving browsed items", () =>
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
    const pinned = reference("https://github.com/owner/repo/issues/21")
    yield* store.update(
      "ses_one",
      ({ feed }) => {
        expect(feed?.items.length).toBe(40)
        return { ...initial, items: [pinned] }
      },
      { reveal: true, pin: pinned },
    )
    yield* store.update("ses_one", (snapshot) => {
      expect(snapshot).toEqual({ feed: { ...initial, items: [pinned], revision: 41, navigation: 41 }, pinned })
      return { ...initial, items: [item] }
    })
    expect((yield* store.current("ses_one"))?.navigation).toBe(41)
    expect(yield* store.reference("ses_one", pinned.url)).toEqual(pinned)
    expect(yield* store.reference("ses_one", item.url)).toBeUndefined()
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
              key === "browser.v2/ses_blocked"
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
