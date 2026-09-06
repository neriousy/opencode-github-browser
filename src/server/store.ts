import type { StorageDomain } from "@opencode-ai/plugin/effect/storage"
import { Context, Effect, Layer, RcMap, Schema, Semaphore } from "effect"
import { Feed, Item } from "../shared/rpc"
import { ViewError } from "./errors"
import { githubURL } from "../shared/url"
import { isLegacyMcpFeed } from "../shared/feed"

const Snapshot = Schema.Struct({
  feed: Schema.NullOr(Feed),
  cache: Schema.Array(Item),
  observed: Schema.optional(Schema.Array(Item)),
})
export type Snapshot = typeof Snapshot.Type

export class FeedStorage extends Context.Service<FeedStorage, Pick<StorageDomain, "get" | "set">>()(
  "github-browser/FeedStorage",
) {}

export class FeedStore extends Context.Service<FeedStore>()("github-browser/FeedStore", {
  make: Effect.gen(function* () {
    const storage = yield* FeedStorage
    const locks = yield* RcMap.make({ lookup: (_sessionID: string) => Semaphore.make(1) })
    const load = Effect.fn("FeedStore.load")(
      function* (sessionID: string) {
        const stored = yield* storage.get(`view/${sessionID}`)
        if (stored !== undefined) return yield* Schema.decodeUnknownEffect(Snapshot)(stored)
        const old = yield* storage.get(`session/${sessionID}`)
        const feed = old === undefined ? null : yield* Schema.decodeUnknownEffect(Schema.NullOr(Feed))(old)
        return { feed, cache: feed?.items ?? [], observed: feed?.items ?? [] }
      },
      Effect.mapError(() => new ViewError({ message: "The saved GitHub view could not be read." })),
    )
    const locked = <A, E>(sessionID: string, task: Effect.Effect<A, E>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const lock = yield* RcMap.get(locks, sessionID)
          return yield* lock.withPermit(task)
        }),
      )
    const save = Effect.fn("FeedStore.save")(function* (sessionID: string, snapshot: Snapshot) {
      const encoded = yield* Schema.encodeEffect(Snapshot)(snapshot).pipe(
        Effect.mapError(() => new ViewError({ message: "The GitHub view could not be saved." })),
      )
      // Complete the small durable commit once admitted; waiting and network reads remain interruptible.
      yield* storage.set(`view/${sessionID}`, encoded).pipe(Effect.uninterruptible)
    })
    return {
      current: Effect.fn("FeedStore.current")((sessionID: string) =>
        locked(
          sessionID,
          load(sessionID).pipe(Effect.map(({ feed }) => (feed && !isLegacyMcpFeed(feed) ? feed : null))),
        ),
      ),
      reference: Effect.fn("FeedStore.reference")(function* (sessionID: string, url: string) {
        const identity = githubURL(url)
        if (!identity) return
        return yield* locked(
          sessionID,
          load(sessionID).pipe(
            Effect.map((snapshot) =>
              [...(snapshot.feed?.items ?? []), ...snapshot.cache, ...(snapshot.observed ?? [])].find(
                (item) => item.repository === identity.repository && item.number === identity.number,
              ),
            ),
          ),
        )
      }),
      update: Effect.fn("FeedStore.update")(
        (sessionID: string, change: (snapshot: Snapshot) => Feed | ViewError | null, reveal = false) =>
          locked(
            sessionID,
            Effect.gen(function* () {
              const snapshot = yield* load(sessionID)
              const changed = change({
                ...snapshot,
                feed: snapshot.feed && isLegacyMcpFeed(snapshot.feed) ? null : snapshot.feed,
              })
              if (changed instanceof ViewError) return yield* changed
              if (!changed) return null
              const revision = (snapshot.feed?.revision ?? 0) + 1
              const feed: Feed = {
                ...changed,
                revision,
                navigation: reveal ? revision : (snapshot.feed?.navigation ?? 0),
              }
              const cache = [
                ...new Map(
                  [...snapshot.cache, ...feed.items].map((item) => [`${item.repository}:${item.number}`, item]),
                ).values(),
              ]
              yield* save(sessionID, { ...snapshot, feed, cache })
              return feed
            }),
          ),
      ),
    }
  }),
}) {
  static readonly layer = Layer.effect(FeedStore, FeedStore.make)
}
