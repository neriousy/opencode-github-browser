import { expect } from "bun:test"
import { Effect, Exit, Layer, Scope, Schema } from "effect"
import { Session } from "@opencode-ai/schema/session"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import type { SessionContext } from "@opencode-ai/plugin/effect/session"
import { reference } from "../../src/shared/url"
import { activate } from "../../src/server/index"
import { testEffect } from "../helpers"
import { detailFeed } from "../fixtures"

testEffect(Layer.empty)("registrations remain alive after activation and are disposed on plugin unload", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const active = new Set<string>()
    const values = new Map<string, Schema.Json>()
    const item = {
      ...reference("https://github.com/owner/repo/issues/42"),
      title: "Pinned reference",
      body: "Description reaches the model request",
      bodyLoaded: true,
    }
    values.set("browser.v2/ses_item", {
      feed: detailFeed(item),
      pinned: item,
    })
    const contextCallbacks: Effect.Effect<void>[] = []
    const context: SessionContext = {
      sessionID: Session.ID.make("ses_item"),
      agent: Agent.ID.make("build"),
      model: Schema.decodeUnknownSync(Model.Ref)({ providerID: "fixture", id: "model" }),
      system: [{ type: "text", text: "Host instructions" }],
      messages: [],
      tools: {},
      generation: {},
      providerOptions: {},
    }
    const notifications: unknown[] = []
    const register = (name: string) =>
      Effect.gen(function* () {
        active.add(name)
        const dispose = Effect.sync(() => {
          active.delete(name)
        })
        yield* Effect.addFinalizer(() => dispose)
        return { dispose }
      })
    yield* activate({
      location: { directory: "/fixture" },
      storage: {
        get: (key) => Effect.sync(() => values.get(key)),
        set: (key, value) =>
          Effect.sync(() => {
            values.set(key, value)
          }),
      },
      session: {
        get: ({ sessionID }) =>
          Effect.succeed(
            Schema.decodeUnknownSync(Session.Info)({
              id: sessionID,
              projectID: "fixture",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 0, updated: 0 },
              location: { directory: "/fixture" },
              metadata: { "github-browser.reference": "https://github.com/owner/repo/issues/42" },
            }),
          ),
        hook: (_name, callback) => {
          contextCallbacks.push(callback(context))
          return register("context")
        },
      },
      rpc: {
        register: () =>
          register("rpc").pipe(
            Effect.map((registration) => ({
              ...registration,
              events: {
                emit: (_name, data) =>
                  Effect.sync(() => {
                    notifications.push(data)
                  }),
              },
            })),
          ),
      },
    }).pipe(Scope.provide(scope))
    expect([...active]).toEqual(["rpc", "context"])
    expect(notifications).toEqual([])
    expect(values.has("browser.v2/ses_item")).toBe(true)
    expect(context.system).toEqual([{ type: "text", text: "Host instructions" }])
    yield* Effect.all(contextCallbacks)
    expect(context.system).toHaveLength(2)
    expect(context.system[0].text).toBe("Host instructions")
    expect(context.system[1].text).toContain("https://github.com/owner/repo/issues/42")
    expect(context.system[1].text).toContain("Description reaches the model request")
    yield* Scope.close(scope, Exit.void)
    expect(active.size).toBe(0)
  }),
)
