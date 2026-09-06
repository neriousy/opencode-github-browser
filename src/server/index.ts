import type { RpcRegistration } from "@opencode-ai/plugin/effect/rpc"
import type { SessionContext } from "@opencode-ai/plugin/effect/session"
import { Session } from "@opencode-ai/schema/session"
import { Plugin } from "@opencode-ai/plugin/effect"
import { Effect, Layer } from "effect"
import { GitHub, errorMessage, type Feed } from "../shared/rpc"
import { observe } from "./observe"
import { FeedStorage, FeedStore, type Snapshot } from "./store"
import { GhCommand, GitHubClient } from "./github"
import { ImageDownload, Images } from "./images"
import { ViewError } from "./errors"
import { githubURL, reference } from "../shared/url"
import { discussionContext } from "./discussion"

type ServerContext = {
  location: { readonly directory: string }
  storage: Pick<Plugin.Context["storage"], "get" | "set">
  session: Pick<Plugin.Context["session"], "get"> & {
    hook: (
      name: "context",
      callback: (event: SessionContext) => Effect.Effect<void>,
    ) => ReturnType<Plugin.Context["session"]["hook"]>
  }
  rpc: Pick<Plugin.Context["rpc"], "register">
}

export const activate = (ctx: ServerContext) =>
  Effect.gen(function* () {
    // Build in OpenCode's plugin scope so services outlive registration/setup.
    const services = yield* Layer.build(
      Layer.mergeAll(
        FeedStore.layer.pipe(Layer.provide(Layer.succeed(FeedStorage)(ctx.storage))),
        GitHubClient.layer.pipe(Layer.provide(GhCommand.layer)),
        Images.layer.pipe(Layer.provide(ImageDownload.layer)),
      ),
    )
    yield* Effect.gen(function* () {
      const store = yield* FeedStore
      const github = yield* GitHubClient
      const images = yield* Images
      const update = Effect.fn("GitHubBrowser.update")(function* (
        sessionID: string,
        change: (snapshot: Snapshot) => Feed | ViewError | null,
        reveal = false,
      ) {
        const feed = yield* store.update(sessionID, change, reveal)
        if (feed)
          yield* registration.events
            .emit("selected", { sessionID, feed, reveal })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("GitHub view saved; notification failed", { message: errorMessage(error) }),
              ),
            )
        return feed
      })
      const required = (feed: Feed | null) =>
        feed ? Effect.succeed(feed) : Effect.fail(new ViewError({ message: "Could not update the GitHub view." }))
      const registration: RpcRegistration<typeof GitHub> = yield* ctx.rpc.register(GitHub, {
        image: (input, call) =>
          images.load(input.url).pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        current: (input, call) =>
          store
            .current(input.sessionID)
            .pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        pin: (input, call) =>
          Effect.gen(function* () {
            yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
            return yield* update(input.sessionID, () => ({
              items: [input.item],
              selected: input.item.url,
              note: "Pinned GitHub reference",
            })).pipe(Effect.flatMap(required))
          }).pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        open: (input, call) =>
          Effect.gen(function* () {
            yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
            const identity = githubURL(input.url)
            if (!identity) return yield* new ViewError({ message: "Enter a GitHub issue or pull request URL." })
            const requested = reference(identity.url)
            return yield* update(
              input.sessionID,
              ({ feed, cache, observed }) => {
                const item =
                  [...(observed ?? []), ...cache].find(
                    (item) => item.repository === requested.repository && item.number === requested.number,
                  ) ?? requested
                return {
                  items: [...new Map([...(feed?.items ?? []), item].map((item) => [item.url, item])).values()],
                  selected: item.url,
                  note: "GitHub",
                  ...(feed?.search ? { search: feed.search } : {}),
                }
              },
              true,
            ).pipe(Effect.flatMap(required))
          }).pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        search: (input, call) =>
          Effect.gen(function* () {
            yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
            const response = yield* github.search(
              input.query,
              input.kind,
              input.page,
              ctx.location.directory,
              input.refresh,
            )
            return yield* update(
              input.sessionID,
              (snapshot) => {
                if (
                  input.page > 1 &&
                  (snapshot.feed?.search?.query !== response.query ||
                    snapshot.feed.search.kind !== input.kind ||
                    snapshot.feed.search.page !== input.page - 1)
                )
                  return new ViewError({ message: "The search changed. Load more from the current search instead." })
                const next = observe(
                  input.page === 1 ? null : snapshot.feed,
                  "search_issues",
                  { query: response.query },
                  { output: response },
                  snapshot.cache,
                )
                if (!next) return new ViewError({ message: "Could not decode GitHub search results." })
                return {
                  ...next,
                  selected: null,
                  note: `GitHub search · ${response.query}`,
                  search: {
                    query: response.query,
                    text: input.page === 1 ? input.query : (snapshot.feed?.search?.text ?? input.query),
                    kind: input.kind,
                    page: input.page,
                    total: response.total_count,
                    incomplete: response.incomplete_results,
                  },
                }
              },
              input.page === 1,
            ).pipe(Effect.flatMap(required))
          }).pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        read: (input, call) =>
          Effect.gen(function* () {
            yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
            const response = yield* github.read(input.url, input.part, input.refresh)
            return yield* update(input.sessionID, (snapshot) => {
              const next = observe(snapshot.feed, response.tool, response.input, response.result, snapshot.cache)
              return next
                ? {
                    ...next,
                    note: snapshot.feed?.note ?? "GitHub",
                    ...(snapshot.feed?.search ? { search: snapshot.feed.search } : {}),
                  }
                : new ViewError({ message: "Could not decode the GitHub response." })
            }).pipe(Effect.flatMap(required))
          }).pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
      })

      yield* ctx.session.hook("context", (event) =>
        discussionContext(ctx.session, event.sessionID).pipe(
          Effect.provideContext(services),
          Effect.tap((text) =>
            Effect.sync(() => {
              if (text) event.system.push({ type: "text", text })
            }),
          ),
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning("GitHub conversation context could not be loaded", { message: errorMessage(error) }),
          ),
        ),
      )
    }).pipe(Effect.provideContext(services))
  }).pipe(Effect.orDie)

export default Plugin.define({ id: "github-browser", effect: activate })
