import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import { Schema } from "effect"
import { browserQueries, createQueryClient } from "../../src/tui/query"
import { Kind, Part, type Feed, type SearchPage } from "../../src/shared/rpc"
import { reference } from "../../src/shared/url"

const location = { directory: "/fixture" }
const item = { ...reference("https://github.com/owner/repo/pull/42"), body: "Details", bodyLoaded: true }
const empty: Feed = { items: [], selected: null, note: "" }

function client(response: (request: Request) => Promise<Response>) {
  return OpenCode.make({
    baseUrl: "http://fixture.invalid",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => response(new Request(input, init)), {
      preconnect: () => {},
    }),
  })
}

test("two panes share a read; cancelling one detaches it without cancelling the other", async () => {
  const cache = createQueryClient()
  const ready = Promise.withResolvers<Request>()
  const reply = Promise.withResolvers<Response>()
  const requests: Request[] = []
  const queries = browserQueries(
    cache,
    client(async (request) => {
      requests.push(request)
      ready.resolve(request)
      return reply.promise
    }),
  )
  const first = new AbortController()
  const second = new AbortController()
  try {
    const a = queries.read(location, item.url, "details", false, first.signal)
    const b = queries.read(location, item.url, "details", false, second.signal)
    const request = await ready.promise
    const stopped = a.catch((error: unknown) => error)
    first.abort()
    expect(await stopped).toBeInstanceOf(Error)
    expect(request.signal.aborted).toBe(false)
    reply.resolve(Response.json({ output: { part: "details", item } }))
    expect(await b).toEqual({ part: "details", item })
    expect(await queries.read(location, item.url, "details", false, new AbortController().signal)).toEqual({
      part: "details",
      item,
    })
    expect(requests).toHaveLength(1)
    expect(new URL(request.url).pathname).toBe("/api/rpc/github-browser/read")
  } finally {
    first.abort()
    second.abort()
    cache.clear()
  }
})

test("last-reader cancellation aborts RPC, discards a late response, and permits reopening", async () => {
  const cache = createQueryClient()
  const ready = Promise.withResolvers<Request>()
  const late = Promise.withResolvers<Response>()
  let count = 0
  const queries = browserQueries(
    cache,
    client(async (request) => {
      if (++count === 1) {
        ready.resolve(request)
        return late.promise
      }
      return Response.json({ output: { part: "details", item } })
    }),
  )
  const controller = new AbortController()
  try {
    const pending = queries.read(location, item.url, "details", false, controller.signal)
    const request = await ready.promise
    const stopped = pending.catch((error: unknown) => error)
    controller.abort()
    expect(await stopped).toBeInstanceOf(Error)
    expect(request.signal.aborted).toBe(true)
    late.resolve(Response.json({ output: { part: "details", item: { ...item, body: "Obsolete" } } }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(queries.readState(location, item.url, "details")?.data).toBeUndefined()
    expect(await queries.read(location, item.url, "details", false, new AbortController().signal)).toEqual({
      part: "details",
      item,
    })
    expect(count).toBe(2)
  } finally {
    cache.clear()
  }
})

test("read keys isolate locations and parts; stale reads refetch and explicit refresh bypasses the server cache", async () => {
  const cache = createQueryClient()
  const requests: { part: string; refresh?: boolean }[] = []
  const queries = browserQueries(
    cache,
    client(async (request) => {
      const { input } = Schema.decodeUnknownSync(
        Schema.Struct({ input: Schema.Struct({ part: Part, refresh: Schema.optional(Schema.Boolean) }) }),
      )(await request.json())
      requests.push(input)
      const output =
        input.part === "comments" ? { part: input.part, url: item.url, comments: [] } : { part: "details", item }
      return Response.json({ output })
    }),
  )
  const signal = new AbortController().signal
  try {
    await queries.read(location, item.url, "details", false, signal)
    await queries.read(location, item.url, "comments", false, signal)
    await queries.read({ directory: "/other" }, item.url, "details", false, signal)
    expect(requests).toHaveLength(3)
    const query = cache.getQueryCache().getAll()[0]
    if (!query) throw new Error("Missing query")
    cache.setQueryData(query.queryKey, query.state.data, { updatedAt: 1 })
    await queries.read(location, item.url, "details", false, signal)
    await queries.read(location, item.url, "details", true, signal)
    expect(requests).toHaveLength(5)
    expect(requests.at(-1)).toEqual({ part: "details", refresh: true })
  } finally {
    cache.clear()
  }
})

test("failed reads remain retryable without automatic retries", async () => {
  const cache = createQueryClient()
  let count = 0
  const queries = browserQueries(
    cache,
    client(async () =>
      ++count === 1
        ? Response.json({ type: "unavailable", message: "Offline", data: {} }, { status: 500 })
        : Response.json({ output: { part: "details", item } }),
    ),
  )
  const signal = new AbortController().signal
  try {
    await expect(queries.read(location, item.url, "details", false, signal)).rejects.toThrow("Offline")
    expect(count).toBe(1)
    expect(queries.readState(location, item.url, "details")?.status).toBe("error")
    await queries.read(location, item.url, "details", true, signal)
    expect(count).toBe(2)
    expect(queries.readState(location, item.url, "details")?.status).toBe("success")
  } finally {
    cache.clear()
  }
})

test("returning to a search restores explicitly loaded comments from the query cache", async () => {
  const cache = createQueryClient()
  const paths: string[] = []
  const queries = browserQueries(
    cache,
    client(async (request) => {
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path.endsWith("/read"))
        return Response.json({
          output: {
            part: "comments",
            url: item.url,
            comments: [{ id: "1", author: "alice", body: "Discussion" }],
          },
        })
      return Response.json({
        output: {
          items: [item],
          query: "repo:owner/repo",
          kind: "pr",
          page: 1,
          total: 1,
          incomplete: false,
        },
      })
    }),
  )
  const signal = new AbortController().signal
  try {
    const first = await queries.search(location, "repo:owner/repo", "pr", false, false, empty, signal)
    expect(first.pages[0].items[0].commentsLoaded).toBe(false)
    await queries.read(location, item.url, "comments", false, signal)
    const again = await queries.search(location, "repo:owner/repo", "pr", false, false, empty, signal)
    expect(again.pages[0].items[0]).toMatchObject({ commentsLoaded: true, comments: [{ body: "Discussion" }] })
    expect(paths).toEqual(["/api/rpc/github-browser/search", "/api/rpc/github-browser/read"])
  } finally {
    cache.clear()
  }
})

test("infinite searches cache loaded pages, resume saved pagination, and refresh from page one", async () => {
  const cache = createQueryClient()
  const requests: { query: string; page: number; kind: string; refresh?: boolean }[] = []
  const queries = browserQueries(
    cache,
    client(async (request) => {
      const { input } = Schema.decodeUnknownSync(
        Schema.Struct({
          input: Schema.Struct({
            query: Schema.String,
            page: Schema.Number,
            kind: Kind,
            refresh: Schema.optional(Schema.Boolean),
          }),
        }),
      )(await request.json())
      requests.push(input)
      return Response.json({ output: page(input.page, input.query) })
    }),
  )
  const signal = new AbortController().signal
  const page = (number: number, query = "is:open"): SearchPage => ({
    items: Array.from({ length: 50 }, (_, index) =>
      reference(`https://github.com/owner/repo/issues/${(number - 1) * 50 + index + 1}`),
    ),
    query: `repo:owner/repo ${query}`,
    kind: "issue",
    page: number,
    total: 200,
    incomplete: false,
  })
  const saved = (pages: SearchPage[]): Feed => ({
    items: pages.flatMap((page) => page.items),
    selected: null,
    note: "",
    search: { ...page(pages.length), text: "is:open" },
  })
  try {
    const first = await queries.search(location, "is:open", "issue", false, false, empty, signal)
    const next = await queries.search(location, "is:open", "issue", true, false, saved(first.pages), signal)
    expect(next.pages.map((page) => page.page)).toEqual([1, 2])
    expect(await queries.search(location, "is:open", "issue", false, false, empty, signal)).toEqual(next)
    // A second pane with only page one can reuse page two without fetching page three.
    expect(await queries.search(location, "is:open", "issue", true, false, saved(first.pages), signal)).toEqual(next)
    expect(requests.map((request) => request.page)).toEqual([1, 2])
    const refreshed = await queries.search(location, "is:open", "issue", false, true, saved(next.pages), signal)
    expect(refreshed.pages).toHaveLength(1)
    expect(requests.at(-1)).toMatchObject({ page: 1, refresh: true })
    // Another pane's saved page count survives a shared-cache refresh.
    const resumed = await queries.search(location, "is:open", "issue", true, false, saved(next.pages), signal)
    expect(resumed.pages.map((page) => page.page)).toEqual([1, 2, 3])
    expect(requests.at(-1)?.page).toBe(3)
    cache.clear()
    const restored = await queries.search(location, "is:open", "issue", true, false, saved([page(1), page(2)]), signal)
    expect(restored.pages.map((page) => page.page)).toEqual([1, 2, 3])
    expect(requests.map((request) => request.page)).toEqual([1, 2, 1, 1, 2, 3, 1, 2, 3])
  } finally {
    cache.clear()
  }
})
