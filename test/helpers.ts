import { test } from "bun:test"
import { Effect, Layer, type Scope } from "effect"

// Like OpenCode's Bun Effect tests, keep runtime/scoping at the test boundary.
export function testEffect<R, E>(layer: Layer.Layer<R, E>) {
  return <A, E2>(name: string, body: () => Effect.Effect<A, E2, R | Scope.Scope>) =>
    test(name, () => Effect.runPromise(Effect.scoped(Effect.suspend(body)).pipe(Effect.provide(layer))))
}
