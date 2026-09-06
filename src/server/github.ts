import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Cache, Context, Effect, Exit, Layer, Option, RcMap, Schema, Semaphore } from "effect"
import { githubURL } from "../shared/url"
import { Kind, Part, SEARCH_PAGE_SIZE } from "../shared/rpc"
import { GitHubError } from "./errors"

const exec = promisify(execFile)
const CommandFailure = Schema.Struct({
  code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  stderr: Schema.optional(Schema.String),
  killed: Schema.optional(Schema.Boolean),
})

/** The only Promise boundary on the server: gh owns authentication and HTTP. */
export class GhCommand extends Context.Service<
  GhCommand,
  {
    readonly run: (args: readonly string[], directory?: string) => Effect.Effect<string, GitHubError>
  }
>()("github-browser/GhCommand") {
  static readonly layer = Layer.succeed(GhCommand)({
    run: Effect.fn("GhCommand.run")((args: readonly string[], directory?: string) =>
      Effect.tryPromise({
        try: (signal) =>
          exec("gh", args, { cwd: directory, signal, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }).then(
            (result) => result.stdout,
          ),
        catch: (cause) => {
          const failure = Option.getOrUndefined(Schema.decodeUnknownOption(CommandFailure)(cause))
          const detail = failure?.stderr?.trim() ?? ""
          const message =
            failure?.code === "ENOENT"
              ? "GitHub CLI is missing on the OpenCode server. Install gh and run gh auth login."
              : failure?.killed
                ? "GitHub took too long to respond. Retry the request."
                : /not a git repository|no git remotes|none of the git remotes/i.test(detail)
                  ? "No GitHub repository found for this project. Search with repo:owner/repo or open a GitHub URL."
                  : /auth login|not logged|authentication|HTTP 401/i.test(detail)
                    ? "Sign in to GitHub on the OpenCode server with gh auth login, then retry."
                    : /rate limit|HTTP 429/i.test(detail)
                      ? "GitHub's rate limit was reached. Wait a little, then retry."
                      : /HTTP 404/i.test(detail)
                        ? "This GitHub item was not found, or your gh account cannot access it."
                        : detail || "Could not reach GitHub. Check the connection on the OpenCode server and retry."
          return new GitHubError({ message })
        },
      }),
    ),
  })
}

const Repository = Schema.Struct({
  nameWithOwner: Schema.String.check(Schema.isPattern(/^[\w.-]+\/[\w.-]+$/)),
  url: Schema.String.check(Schema.isPattern(/^https:\/\/github\.com\//)),
})

const SearchResponse = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  total_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  incomplete_results: Schema.Boolean,
})

export class GitHubClient extends Context.Service<GitHubClient>()("github-browser/GitHubClient", {
  make: Effect.gen(function* () {
    const command = yield* GhCommand
    type Request = { readonly args: readonly string[]; readonly directory: string }
    const readJSON = Effect.fn("GitHubClient.readJSON")(function* (key: Request) {
      const output = yield* command.run(key.args, key.directory || undefined)
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(output).pipe(
        Effect.mapError(() => new GitHubError({ message: "GitHub returned invalid JSON. Retry the request." })),
      )
    })
    const responses = yield* Cache.makeWith(readJSON, {
      capacity: 128,
      timeToLive: (exit, key) => (Exit.isFailure(exit) ? 0 : key.args[0] === "repo" ? "5 minutes" : "1 minute"),
    })
    const locks = yield* RcMap.make({ lookup: (_key: Request) => Semaphore.make(1) })
    // Keep the CLI request in its caller's scope; concurrent readers share the completed value.
    const json = Effect.fn("GitHubClient.json")((args: readonly string[], directory?: string, refresh = false) =>
      Effect.scoped(
        Effect.gen(function* () {
          const key = { args, directory: directory ?? "" }
          const lock = yield* RcMap.get(locks, key)
          return yield* lock.withPermit(
            Effect.gen(function* () {
              if (!refresh) {
                const cached = yield* Cache.getSuccess(responses, key)
                if (Option.isSome(cached)) return cached.value
              }
              const value = yield* readJSON(key)
              yield* Cache.set(responses, key, value)
              return value
            }),
          )
        }),
      ),
    )
    return {
      read: Effect.fn("GitHubClient.read")(function* (url: string, part: typeof Part.Type, refresh = false) {
        const item = githubURL(url)
        if (!item) return yield* new GitHubError({ message: "Unsupported GitHub issue or pull request URL." })
        if (part === "diff" && item.kind !== "pr")
          return yield* new GitHubError({ message: "Only pull requests have diffs." })
        const resource = part === "comments" || item.kind === "issue" ? "issues" : "pulls"
        const endpoint = `repos/${item.owner}/${item.repo}/${resource}/${item.number}${part === "comments" ? "/comments" : part === "diff" ? "/files" : ""}`
        const paginated = part !== "details"
        const args = [
          "api",
          "--hostname",
          "github.com",
          "--method",
          "GET",
          endpoint + (paginated ? "?per_page=100" : ""),
        ]
        if (paginated) args.push("--paginate", "--slurp")
        const response = yield* json(args, undefined, refresh)
        const output = paginated
          ? (yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Array(Schema.Unknown)))(response).pipe(
              Effect.mapError(() => new GitHubError({ message: "GitHub returned an unexpected paginated response." })),
            )).flat()
          : response
        return {
          tool: item.kind === "pr" ? "pull_request_read" : "issue_read",
          input: {
            owner: item.owner,
            repo: item.repo,
            issue_number: item.kind === "issue" ? item.number : undefined,
            pullNumber: item.kind === "pr" ? item.number : undefined,
            method: part === "details" ? "get" : part === "comments" ? "get_comments" : "get_files",
          },
          result: { output },
        }
      }),
      search: Effect.fn("GitHubClient.search")(function* (
        query: string,
        kind: typeof Kind.Type,
        page: number,
        directory: string,
        refresh = false,
      ) {
        const scoped = (query.match(/"[^"\n]*"|\S+/g) ?? []).some((token) => /^(repo|org|user):/i.test(token))
        const repository = scoped
          ? undefined
          : yield* Schema.decodeUnknownEffect(Repository)(
              yield* json(["repo", "view", "--json", "nameWithOwner,url"], directory, refresh),
            ).pipe(
              Effect.mapError(
                () =>
                  new GitHubError({
                    message:
                      "This project does not resolve to a github.com repository. Search with repo:owner/repo or open a GitHub URL.",
                  }),
              ),
            )
        const resolved = repository ? `repo:${repository.nameWithOwner} ${query.trim()}` : query.trim()
        const output = yield* json(
          [
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            "search/issues",
            "-f",
            `q=${resolved}${kind === "all" ? "" : ` is:${kind}`}`,
            "-f",
            `per_page=${SEARCH_PAGE_SIZE}`,
            "-f",
            `page=${page}`,
          ],
          undefined,
          refresh,
        )
        const result = yield* Schema.decodeUnknownEffect(SearchResponse)(output).pipe(
          Effect.mapError(() => new GitHubError({ message: "GitHub returned unexpected search results." })),
        )
        return { ...result, query: resolved }
      }),
    }
  }),
}) {
  static readonly layer = Layer.effect(GitHubClient, GitHubClient.make)
}
