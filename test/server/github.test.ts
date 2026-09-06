import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { GhCommand, GitHubClient } from "../../src/server/github"
import { TestClock } from "effect/testing"
import { testEffect } from "../helpers"

const url = "https://github.com/owner/repo/pull/42"
function client(output: string, inspect: (args: readonly string[]) => void = () => {}) {
  return GitHubClient.layer.pipe(
    Layer.provide(
      Layer.succeed(GhCommand)({
        run: (args) =>
          Effect.sync(() => {
            inspect(args)
            return output
          }),
      }),
    ),
  )
}

testEffect(
  client(
    '[[{"filename":"a.ts","status":"modified","additions":1,"deletions":0}],[{"filename":"b.ts","status":"added","additions":2,"deletions":0}]]',
    (args) => {
      expect(args).toContain("repos/owner/repo/pulls/42/files?per_page=100")
      expect(args.slice(-2)).toEqual(["--paginate", "--slurp"])
    },
  ),
)("flattens every changed-file page and requests only GET", () =>
  Effect.gen(function* () {
    const github = yield* GitHubClient
    const result = yield* github.read(url, "diff")
    expect(result).toHaveLength(2)
  }),
)

testEffect(client("not json"))("reports invalid JSON as a typed GitHub error", () =>
  Effect.gen(function* () {
    const github = yield* GitHubClient
    const error = yield* github.read(url, "details").pipe(Effect.flip)
    expect(error._tag).toBe("GitHubError")
    expect(error.message).toContain("invalid JSON")
  }),
)

testEffect(client("[]"))("rejects unsupported URLs and issue diffs before executing gh", () =>
  Effect.gen(function* () {
    const github = yield* GitHubClient
    expect(
      (yield* github.read("https://example.com/owner/repo/pull/42", "details").pipe(Effect.flip)).message,
    ).toContain("Unsupported")
    expect((yield* github.read("https://github.com/owner/repo/issues/42", "diff").pipe(Effect.flip)).message).toContain(
      "Only pull requests",
    )
  }),
)

testEffect(
  client('{"items":[],"total_count":0,"incomplete_results":false}', (args) => {
    expect(args).toContain("q=repo:owner/repo is:open is:pr")
    expect(args).toContain("per_page=50")
    expect(args).toContain("page=2")
  }),
)("search applies the requested kind and page", () =>
  Effect.gen(function* () {
    const github = yield* GitHubClient
    expect((yield* github.search("repo:owner/repo is:open", "pr", 2, "/fixture")).total_count).toBe(0)
  }),
)

testEffect(Layer.empty)("interrupting a request interrupts the command it owns", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const services = yield* Layer.build(
      GitHubClient.layer.pipe(
        Layer.provide(
          Layer.succeed(GhCommand)({
            run: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              ),
          }),
        ),
      ),
    )
    const github = yield* Effect.service(GitHubClient).pipe(Effect.provideContext(services))
    const request = yield* github.read(url, "details").pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(request)
    yield* Deferred.await(stopped)
    expect(yield* Deferred.isDone(stopped)).toBe(true)
  }),
)

const scopedCalls: { args: readonly string[]; directory?: string }[] = []
testEffect(
  GitHubClient.layer.pipe(
    Layer.provide(
      Layer.succeed(GhCommand)({
        run: (args, directory) =>
          Effect.sync(() => {
            scopedCalls.push({ args, directory })
            return args[0] === "repo"
              ? JSON.stringify({ nameWithOwner: "owner/current", url: "https://github.com/owner/current" })
              : JSON.stringify({ items: [], total_count: 0, incomplete_results: false })
          }),
      }),
    ),
  ),
)("unqualified search resolves the repository in the requested project directory", () =>
  Effect.gen(function* () {
    const github = yield* GitHubClient
    const result = yield* github.search("is:open label:bug", "issue", 1, "/worktree/project")
    expect(scopedCalls[0]).toEqual({
      args: ["repo", "view", "--json", "nameWithOwner,url"],
      directory: "/worktree/project",
    })
    expect(scopedCalls[1].args).toContain("q=repo:owner/current is:open label:bug is:issue")
    expect(result.query).toBe("repo:owner/current is:open label:bug")
  }),
)

for (const query of ["repo:other/project bug", "org:other bug", "user:other bug"]) {
  testEffect(
    client('{"items":[],"total_count":0,"incomplete_results":false}', (args) => {
      expect(args[0]).toBe("api")
      expect(args).toContain(`q=${query} is:issue`)
    }),
  )(`explicit scope bypasses current-repository detection: ${query}`, () =>
    Effect.gen(function* () {
      const github = yield* GitHubClient
      expect((yield* github.search(query, "issue", 1, "/not-a-repo")).query).toBe(query)
    }),
  )
}

testEffect(client('{"nameWithOwner":"owner/current","url":"https://gitlab.com/owner/current"}'))(
  "a non-GitHub project cannot silently fall back to global search",
  () =>
    Effect.gen(function* () {
      const github = yield* GitHubClient
      const error = yield* github.search("is:open", "issue", 1, "/fixture").pipe(Effect.flip)
      expect(error.message).toContain("does not resolve to a github.com repository")
    }),
)

testEffect(Layer.empty)("cache shares concurrent reads, expires, and supports explicit refresh", () =>
  Effect.gen(function* () {
    let calls = 0
    const services = yield* Layer.build(
      GitHubClient.layer.pipe(
        Layer.provide(
          Layer.succeed(GhCommand)({
            run: () =>
              Effect.gen(function* () {
                calls++
                yield* Effect.yieldNow
                return JSON.stringify({ number: calls })
              }),
          }),
        ),
      ),
    )
    const github = yield* Effect.service(GitHubClient).pipe(Effect.provideContext(services))
    yield* Effect.forEach(Array.from({ length: 8 }), () => github.read(url, "details"), { concurrency: "unbounded" })
    expect(calls).toBe(1)
    yield* TestClock.adjust("59 seconds")
    yield* github.read(url, "details")
    expect(calls).toBe(1)
    yield* TestClock.adjust("2 seconds")
    yield* github.read(url, "details")
    expect(calls).toBe(2)
    yield* github.read(url, "details", true)
    expect(calls).toBe(3)
    yield* github.read(url, "details")
    expect(calls).toBe(3)
  }).pipe(Effect.provide(TestClock.layer())),
)

testEffect(Layer.empty)("cache distinguishes repository, kind and page, and does not retain failed requests", () =>
  Effect.gen(function* () {
    const calls: string[] = []
    let fail = true
    const services = yield* Layer.build(
      GitHubClient.layer.pipe(
        Layer.provide(
          Layer.succeed(GhCommand)({
            run: (args, directory) =>
              Effect.sync(() => {
                calls.push(JSON.stringify([args, directory]))
                if (args[0] === "repo")
                  return JSON.stringify({
                    nameWithOwner: directory === "/one" ? "owner/one" : "owner/two",
                    url: "https://github.com/owner/repo",
                  })
                if (fail) {
                  fail = false
                  return "not json"
                }
                return JSON.stringify({ items: [], total_count: 0, incomplete_results: false })
              }),
          }),
        ),
      ),
    )
    const github = yield* Effect.service(GitHubClient).pipe(Effect.provideContext(services))
    yield* github.search("is:open", "issue", 1, "/one").pipe(Effect.flip)
    yield* github.search("is:open", "issue", 1, "/one")
    expect(calls).toHaveLength(3)
    yield* github.search("is:open", "issue", 1, "/one")
    expect(calls).toHaveLength(3)
    yield* github.search("is:open", "pr", 1, "/one")
    yield* github.search("is:open", "pr", 2, "/one")
    yield* github.search("is:open", "issue", 1, "/two")
    expect(calls).toHaveLength(7)
  }),
)
