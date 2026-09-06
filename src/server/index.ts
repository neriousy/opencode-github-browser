import type { RpcRegistration } from "@opencode-ai/plugin/effect/rpc"
import type { SessionContext } from "@opencode-ai/plugin/effect/session"
import { Session } from "@opencode-ai/schema/session"
import { Plugin } from "@opencode-ai/plugin/effect"
import { Effect, Layer } from "effect"
import { GitHub, errorMessage, type BrowserView, type Item } from "../shared/rpc"
import { FeedStorage, FeedStore, type Snapshot } from "./store"
import { GhCommand, GitHubClient } from "./github"
import { ImageDownload, Images } from "./images"
import { ViewError } from "./errors"
import { githubURL, reference } from "../shared/url"
import { discussionContext } from "./discussion"
import { Reader } from "./reader"
import { openView, readView, searchView } from "./view"

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
        Reader.layer.pipe(Layer.provide(GitHubClient.layer), Layer.provide(GhCommand.layer)),
        Images.layer.pipe(Layer.provide(ImageDownload.layer)),
      ),
    )
    yield* Effect.gen(function* () {
      const store = yield* FeedStore
      const reader = yield* Reader
      const images = yield* Images
      const update = Effect.fn("GitHubBrowser.update")(function* (
        sessionID: string,
        change: (snapshot: Snapshot) => BrowserView | ViewError,
        options: { reveal?: boolean; pin?: Item } = {},
      ) {
        const feed = yield* store.update(sessionID, change, options)
        yield* registration.events
          .emit("selected", { sessionID, feed, reveal: options.reveal ?? false })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("GitHub view saved; notification failed", { message: errorMessage(error) }),
            ),
          )
        return feed
      })
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
            return yield* update(input.sessionID, (snapshot) => openView(snapshot, input.item), {
              pin: input.item,
            })
          }).pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        open: (input, call) =>
          Effect.gen(function* () {
            yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
            const identity = githubURL(input.url)
            if (!identity) return yield* new ViewError({ message: "Enter a GitHub issue or pull request URL." })
            const requested = reference(identity.url)
            return yield* update(input.sessionID, (snapshot) => openView(snapshot, requested), { reveal: true })
          }).pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        search: (input, call) =>
          reader
            .search(input.query, input.kind, input.page, ctx.location.directory, input.refresh)
            .pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        read: (input, call) =>
          reader
            .read(input.url, input.part, input.refresh)
            .pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        saveSearch: (input, call) =>
          Effect.gen(function* () {
            yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
            return yield* update(input.sessionID, (snapshot) => searchView(snapshot, input.pages, input.text), {
              reveal: input.navigate,
            })
          }).pipe(Effect.mapError((error) => call.error("unavailable", errorMessage(error), {}))),
        saveRead: (input, call) =>
          Effect.gen(function* () {
            yield* ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })
            return yield* update(input.sessionID, (snapshot) => readView(snapshot, input.result))
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
