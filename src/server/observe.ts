import { parsePatch } from "diff"
import { Option, Schema } from "effect"
import { DiffFile, type Feed, type Item } from "../shared/rpc"
import { githubURL } from "../shared/url"

const Author = Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String })))
const Label = Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })])
const Source = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.optional(Schema.String),
  html_url: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  user: Author,
  author: Author,
  labels: Schema.optional(Schema.Union([Schema.Array(Label), Schema.Struct({ nodes: Schema.Array(Label) })])),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  pull_request: Schema.optional(
    Schema.Struct({
      html_url: Schema.optional(Schema.String),
      merged_at: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  merged: Schema.optional(Schema.Boolean),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
})
const Input = Schema.Struct({
  owner: Schema.optional(Schema.String),
  repo: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  issue_number: Schema.optional(Schema.Number),
  pullNumber: Schema.optional(Schema.Number),
  method: Schema.optional(Schema.String),
  page: Schema.optional(Schema.Number),
  after: Schema.optional(Schema.String),
})
const Comment = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Author,
  author: Author,
})
const RecordValue = Schema.Record(Schema.String, Schema.Unknown)
const TextParts = Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))
const parsed = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value))

const reads = new Set([
  "search_issues",
  "list_issues",
  "search_pull_requests",
  "list_pull_requests",
  "issue_read",
  "pull_request_read",
])

/** Normalize GitHub response envelopes into a session-local view; no fetching or tool observation. */
export function observe(
  previous: Feed | null,
  tool: string,
  input: unknown,
  result: unknown,
  cache = previous?.items ?? [],
): Feed | null {
  if (!reads.has(tool)) return null
  const args = parsed(Input, input)
  if (!args) return null
  const data = decode(result)
  const kind = tool.includes("pull_request") ? "pr" : "issue"
  const items = previous?.items ?? []
  const normalize = (source: typeof Source.Type): Item | undefined => {
    const raw =
      source.pull_request?.html_url ??
      source.html_url ??
      source.url ??
      (args.owner && args.repo
        ? `https://github.com/${args.owner}/${args.repo}/${kind === "pr" ? "pull" : "issues"}/${source.number}`
        : undefined)
    if (!raw) return
    const identity = githubURL(raw)
    if (!identity) return
    if (source.pull_request && identity.kind === "issue") {
      identity.kind = "pr"
      identity.url = identity.url.replace("/issues/", "/pull/")
    }
    const url = identity.url
    const old =
      cache.find((item) => item.url === url) ??
      cache.find((item) => item.repository === identity.repository && item.number === identity.number)
    return {
      kind: identity.kind,
      number: identity.number,
      title: source.title ?? old?.title ?? `${kind === "pr" ? "PR" : "Issue"} #${source.number}`,
      url,
      repository: identity.repository,
      state:
        source.merged || source.merged_at || source.pull_request?.merged_at
          ? "merged"
          : (source.state?.toLowerCase() ?? old?.state ?? "unknown"),
      author: source.user?.login ?? source.author?.login ?? old?.author ?? "ghost",
      labels: source.labels
        ? ("nodes" in source.labels ? source.labels.nodes : source.labels).map((label) =>
            typeof label === "string" ? label : label.name,
          )
        : (old?.labels ?? []),
      body: source.body === undefined ? (old?.body ?? "") : (source.body ?? ""),
      bodyLoaded: source.body !== undefined || old?.bodyLoaded === true,
      comments: old?.comments ?? [],
      commentsLoaded: old?.commentsLoaded ?? false,
      files: old?.files ?? null,
      reason: old?.reason ?? "",
    }
  }
  if (tool.startsWith("search_") || tool.startsWith("list_")) {
    const list = collection(data, ["items", "issues", "pullRequests"])
    if (!list) return null
    const found = list.flatMap((row) => {
      const source = parsed(Source, row)
      const item = source ? normalize(source) : undefined
      return item ? [item] : []
    })
    return {
      items: merge(items, found),
      selected: selection(previous?.selected, found),
      note: args.query ? `MCP results · ${args.query}` : `GitHub MCP · ${kind === "pr" ? "pull requests" : "issues"}`,
    }
  }
  if (args.method === "get") {
    const source = parsed(Source, data)
    const item = source ? normalize(source) : undefined
    return item
      ? {
          items: merge(items, [item]),
          selected: selection(previous?.selected, [item]) ?? item.url,
          note: previous?.note ?? "GitHub MCP",
        }
      : null
  }
  const number = args.issue_number ?? args.pullNumber
  if (!number || !args.owner || !args.repo) return null
  const normalized = normalize({ number })
  if (!normalized) return null
  const item = { ...normalized }
  if (args.method === "get_comments") {
    const rows = collection(data, ["comments"])
    const comments = parsed(Schema.Array(Comment), rows)
    if (!comments) return null
    const incoming = comments.map((comment) => ({
      ...(comment.id !== undefined ? { id: String(comment.id) } : {}),
      author: comment.user?.login ?? comment.author?.login ?? "ghost",
      body: comment.body ?? "",
    }))
    const combined = (args.page && args.page > 1) || args.after ? [...item.comments, ...incoming] : incoming
    item.comments = [
      ...new Map(
        combined.map((comment) => [comment.id ?? JSON.stringify([comment.author, comment.body]), comment]),
      ).values(),
    ]
    item.commentsLoaded = true
  } else if (args.method === "get_files") {
    const files = parsed(Schema.Array(DiffFile), data)
    if (!files) return null
    item.files =
      args.page && args.page > 1
        ? [...new Map([...(item.files ?? []), ...files].map((file) => [file.filename, file])).values()]
        : files
  } else if (args.method === "get_diff" && typeof data === "string") {
    item.files = parsePatch(data).map((patch) => ({
      filename:
        (patch.newFileName === "/dev/null" ? patch.oldFileName : patch.newFileName)?.replace(/^[ab]\//, "") ??
        "unknown",
      status: patch.newFileName === "/dev/null" ? "removed" : patch.oldFileName === "/dev/null" ? "added" : "modified",
      additions: patch.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith("+")).length,
      deletions: patch.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith("-")).length,
      patch: patch.hunks
        .map((hunk) =>
          [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join("\n"),
        )
        .join("\n"),
    }))
  } else return null
  return {
    items: merge(items, [item]),
    selected: previous?.selected ?? item.url,
    note: previous?.note ?? "GitHub MCP",
  }
}

function merge(items: readonly Item[], incoming: readonly Item[]) {
  // GitHub's /issues API can return a PR; both share the repository's number space.
  return [...new Map([...items, ...incoming].map((item) => [`${item.repository}:${item.number}`, item])).values()]
}

function selection(selected: string | null | undefined, incoming: readonly Item[]) {
  if (!selected) return null
  const identity = githubURL(selected)
  return (
    incoming.find((item) => item.repository === identity?.repository && item.number === identity.number)?.url ??
    selected
  )
}

function decode(value: unknown, depth = 0): unknown {
  if (depth > 5) return undefined
  if (typeof value === "string") {
    if (!/^[\s]*[\[{]/.test(value)) return value
    const json = parsed(Schema.fromJsonString(Schema.Unknown), value)
    return json === undefined ? undefined : decode(json, depth + 1)
  }
  const result = parsed(RecordValue, value)
  if (!result) return value
  if (result.isError === true) return undefined
  if (result.output != null) return decode(result.output, depth + 1)
  if (result.structuredContent != null) return decode(result.structuredContent, depth + 1)
  if (typeof result.content === "string") return decode(result.content, depth + 1)
  if (Array.isArray(result.content)) {
    const text = (parsed(TextParts, result.content) ?? []).flatMap((part) =>
      part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    return decode(text.join("\n"), depth + 1)
  }
  return value
}

function collection(value: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(value)) return value
  const object = parsed(RecordValue, value)
  if (!object) return
  for (const key of [...keys, "nodes"]) {
    if (object[key] !== undefined) return collection(object[key], [])
  }
}
