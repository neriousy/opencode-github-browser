import { Context, Effect, Layer, Schema } from "effect"
import { DiffFile, type Item, type Kind, type Part, type ReadResult, type SearchPage } from "../shared/rpc"
import { githubURL, reference } from "../shared/url"
import { GitHubClient } from "./github"
import { ViewError } from "./errors"

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }))
const ItemURL = Schema.String.check(Schema.makeFilter((url: string) => githubURL(url) !== undefined))
const Source = Schema.Struct({
  html_url: ItemURL,
  title: Schema.String,
  state: Schema.String,
  user: Author,
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  body: Schema.NullOr(Schema.String),
  pull_request: Schema.optional(
    Schema.Struct({
      html_url: Schema.optional(ItemURL),
      merged_at: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  merged: Schema.optional(Schema.Boolean),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
})
const Comments = Schema.Array(Schema.Struct({ id: Schema.Number, body: Schema.NullOr(Schema.String), user: Author }))

/** Resource reads have no session, storage, navigation, or event side effects. */
export class Reader extends Context.Service<Reader>()("github-browser/Reader", {
  make: Effect.gen(function* () {
    const github = yield* GitHubClient
    return {
      search: Effect.fn("Reader.search")(function* (
        query: string,
        kind: typeof Kind.Type,
        page: number,
        directory: string,
        refresh = false,
      ) {
        const response = yield* github.search(query, kind, page, directory, refresh)
        const sources = yield* Schema.decodeUnknownEffect(Schema.Array(Source))(response.items).pipe(
          Effect.mapError(() => new ViewError({ message: "GitHub returned unexpected search results." })),
        )
        return {
          items: sources.map(normalize),
          query: response.query,
          kind,
          page,
          total: response.total_count,
          incomplete: response.incomplete_results,
        } satisfies SearchPage
      }),
      read: Effect.fn("Reader.read")(function* (url: string, part: typeof Part.Type, refresh = false) {
        const response = yield* github.read(url, part, refresh)
        if (part === "comments") {
          const comments = yield* Schema.decodeUnknownEffect(Comments)(response).pipe(
            Effect.mapError(() => new ViewError({ message: "GitHub returned unexpected discussion comments." })),
          )
          return {
            part,
            url,
            comments: comments.map((comment) => ({
              id: String(comment.id),
              body: comment.body ?? "",
              author: comment.user?.login ?? "ghost",
            })),
          } satisfies ReadResult
        }
        if (part === "diff") {
          const files = yield* Schema.decodeUnknownEffect(Schema.Array(DiffFile))(response).pipe(
            Effect.mapError(() => new ViewError({ message: "GitHub returned unexpected changed files." })),
          )
          return { part, url, files } satisfies ReadResult
        }
        const source = yield* Schema.decodeUnknownEffect(Source)(response).pipe(
          Effect.mapError(() => new ViewError({ message: "GitHub returned unexpected item details." })),
        )
        return { part, item: normalize(source) } satisfies ReadResult
      }),
    }
  }),
}) {
  static readonly layer = Layer.effect(Reader, Reader.make)
}

function normalize(source: typeof Source.Type): Item {
  const url = source.pull_request
    ? (source.pull_request.html_url ?? source.html_url.replace("/issues/", "/pull/"))
    : source.html_url
  return {
    ...reference(url),
    title: source.title,
    state: source.merged || source.merged_at || source.pull_request?.merged_at ? "merged" : source.state,
    author: source.user?.login ?? "ghost",
    labels: source.labels.map((label) => label.name),
    body: source.body ?? "",
    bodyLoaded: true,
  }
}
