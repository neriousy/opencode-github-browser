import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Cache, Context, Effect, Layer, Option, RcMap, Semaphore } from "effect"
import { imageURL } from "../shared/image"
import { GitHubError } from "./errors"

const exec = promisify(execFile)
const limit = 8 * 1024 * 1024

export class ImageDownload extends Context.Service<
  ImageDownload,
  {
    readonly load: (url: string) => Effect.Effect<Uint8Array, GitHubError>
  }
>()("github-browser/ImageDownload") {
  static readonly layer = Layer.succeed(ImageDownload)({
    load: Effect.fn("ImageDownload.load")((url: string) =>
      Effect.tryPromise({
        try: (signal) =>
          exec("gh", ["api", "--hostname", "github.com", "--method", "GET", url, "-H", "Accept: image/*"], {
            signal,
            encoding: "buffer",
            maxBuffer: limit,
            timeout: 30_000,
          }).then((result) => result.stdout),
        catch: () =>
          new GitHubError({ message: "Image unavailable. Check gh access or retry; previews are limited to 8 MB." }),
      }),
    ),
  })
}

export class Images extends Context.Service<Images>()("github-browser/Images", {
  make: Effect.gen(function* () {
    const download = yield* ImageDownload
    const read = Effect.fn("Images.read")(function* (url: string) {
      const bytes = yield* download.load(url)
      if (!bytes.length || bytes.length > limit)
        return yield* new GitHubError({ message: "Image is empty or exceeds the 8 MB preview limit." })
      const signature = Buffer.from(bytes.subarray(0, 12))
      if (
        !(
          signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
          /^GIF8[79]a/.test(signature.toString("ascii")) ||
          (signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "WEBP")
        )
      )
        return yield* new GitHubError({ message: "No preview for this image format. Supported: PNG, JPEG, GIF, WebP." })
      return { data: Buffer.from(bytes).toString("base64") }
    })
    const cache = yield* Cache.makeWith(read, { capacity: 16, timeToLive: () => "5 minutes" })
    const locks = yield* RcMap.make({ lookup: (_url: string) => Semaphore.make(1) })
    return {
      load: Effect.fn("Images.load")((input: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const url = imageURL(input)
            if (!url) return yield* new GitHubError({ message: "Previews support GitHub-hosted images only." })
            const lock = yield* RcMap.get(locks, url)
            return yield* lock.withPermit(
              Effect.gen(function* () {
                const cached = yield* Cache.getSuccess(cache, url)
                if (Option.isSome(cached)) return cached.value
                const result = yield* read(url)
                yield* Cache.set(cache, url, result)
                return result
              }),
            )
          }),
        ),
      ),
    }
  }),
}) {
  static readonly layer = Layer.effect(Images, Images.make)
}
