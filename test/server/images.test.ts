import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { ImageDownload, Images } from "../../src/server/images"
import { GitHubError } from "../../src/server/errors"
import { testEffect } from "../helpers"

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
const url = "https://github.com/user-attachments/assets/fixture"

testEffect(Layer.empty)("attachment cache shares successful downloads and rejects non-GitHub sources", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    const services = yield* Layer.build(
      Images.layer.pipe(
        Layer.provide(
          Layer.succeed(ImageDownload)({
            load: (url) =>
              Effect.sync(() => {
                calls.push(url)
                return png
              }),
          }),
        ),
      ),
    )
    const images = yield* Effect.service(Images).pipe(Effect.provideContext(services))
    const results = yield* Effect.forEach([url, url, url], images.load, { concurrency: "unbounded" })
    expect(calls).toEqual([url])
    expect(results[0].data).toBe(Buffer.from(png).toString("base64"))
    for (const source of [
      "file:///etc/passwd",
      "http://localhost/image",
      "https://github.com.evil.test/image",
      "https://user:pass@github.com/assets/image",
      "https://github.com/login",
    ]) {
      expect(yield* images.load(source).pipe(Effect.flip)).toBeInstanceOf(GitHubError)
    }
    expect(calls).toEqual([url])
  }),
)

testEffect(Layer.empty)("failed attachment downloads remain retryable and cancellation interrupts the download", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const cancelled = yield* Deferred.make<void>()
    let attempts = 0
    const services = yield* Layer.build(
      Images.layer.pipe(
        Layer.provide(
          Layer.succeed(ImageDownload)({
            load: () =>
              Effect.suspend(() => {
                attempts++
                if (attempts === 1) return Effect.fail(new GitHubError({ message: "Network unavailable" }))
                return Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
                )
              }),
          }),
        ),
      ),
    )
    const images = yield* Effect.service(Images).pipe(Effect.provideContext(services))
    expect((yield* images.load(url).pipe(Effect.flip)).message).toBe("Network unavailable")
    const request = yield* images.load(url).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(request)
    yield* Deferred.await(cancelled)
    expect(attempts).toBe(2)
  }),
)
