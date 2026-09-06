import type { StandardSchemaV1, StandardJSONSchemaV1 } from "effect/StandardSchema"
import { Rpc } from "@opencode-ai/plugin/rpc"
import { Effect, Option, Schema } from "effect"

export const SEARCH_PAGE_SIZE = 50
export const Kind = Schema.Literals(["all", "issue", "pr"])
export const Part = Schema.Literals(["details", "comments", "diff"])
const Positive = Schema.Int.check(Schema.isGreaterThan(0))
const Nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const URLString = Schema.String.check(Schema.makeFilter((value: string) => URL.canParse(value)))

export const DiffFile = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.String),
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.optional(Schema.String),
})
export type DiffFile = typeof DiffFile.Type

export const Item = Schema.Struct({
  kind: Schema.Literals(["issue", "pr"]),
  number: Positive,
  title: Schema.String,
  url: URLString,
  repository: Schema.String,
  state: Schema.String,
  author: Schema.String,
  labels: Schema.Array(Schema.String),
  body: Schema.String,
  bodyLoaded: Schema.Boolean,
  comments: Schema.Array(
    Schema.Struct({ id: Schema.optional(Schema.String), author: Schema.String, body: Schema.String }),
  ),
  commentsLoaded: Schema.Boolean,
  files: Schema.NullOr(Schema.Array(DiffFile)),
  reason: Schema.String,
})
export type Item = typeof Item.Type

// Retained for decoding durable views from versions that displayed MCP shortlists.
const Shortlist = Schema.Struct({ items: Schema.Array(Item), note: Schema.String })

export const Feed = Schema.Struct({
  revision: Schema.optional(Nonnegative),
  navigation: Schema.optional(Nonnegative),
  items: Schema.Array(Item),
  selected: Schema.NullOr(Schema.String),
  note: Schema.String,
  shortlist: Schema.optional(Shortlist),
  search: Schema.optional(
    Schema.Struct({
      query: Schema.String,
      text: Schema.optional(Schema.String),
      kind: Kind,
      page: Positive,
      total: Nonnegative,
      incomplete: Schema.Boolean,
    }),
  ),
})
export type Feed = typeof Feed.Type

const Session = { sessionID: Schema.String.check(Schema.isPattern(/^ses_/)) }
// Keep host decoding behind Standard Schema: native ASTs are tied to their Effect runtime.
export function portable<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
): StandardSchemaV1<S["Encoded"], S["Type"]> & StandardJSONSchemaV1<S["Encoded"], S["Type"]> {
  return { "~standard": Schema.toStandardSchemaV1(Schema.toStandardJSONSchemaV1(schema))["~standard"] }
}

const errors = { unavailable: portable(Schema.Struct({})) }

export const GitHub = Rpc.define({
  id: "github-browser",
  methods: {
    image: {
      input: portable(Schema.Struct({ url: URLString })),
      output: portable(Schema.Struct({ data: Schema.String })),
      errors,
    },
    current: {
      input: portable(Schema.Struct(Session)),
      output: portable(Schema.NullOr(Feed)),
      errors,
    },
    pin: {
      input: portable(Schema.Struct({ ...Session, item: Item })),
      output: portable(Feed),
      errors,
    },
    open: {
      input: portable(Schema.Struct({ ...Session, url: URLString })),
      output: portable(Feed),
      errors,
    },
    search: {
      input: portable(
        Schema.Struct({
          ...Session,
          refresh: Schema.optional(Schema.Boolean),
          query: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
          kind: Kind.pipe(Schema.withDecodingDefault(Effect.succeed("all"))),
          page: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).pipe(
            Schema.withDecodingDefault(Effect.succeed(1)),
          ),
        }),
      ),
      output: portable(Feed),
      errors,
    },
    read: {
      input: portable(
        Schema.Struct({ ...Session, url: URLString, part: Part, refresh: Schema.optional(Schema.Boolean) }),
      ),
      output: portable(Feed),
      errors,
    },
  },
  events: {
    selected: {
      schema: portable(Schema.Struct({ ...Session, feed: Feed, reveal: Schema.optional(Schema.Boolean) })),
    },
  },
})

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  const result = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }))(error)
  return Option.isSome(result) ? result.value.message : "Could not update the GitHub view."
}
