import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  type InfiniteData,
  type QueryFunctionContext,
} from "@tanstack/query-core"
import type { Plugin } from "@opencode-ai/plugin/tui"
import {
  GitHub,
  SEARCH_PAGE_SIZE,
  type Feed,
  type Kind,
  type Item,
  type Part,
  type ReadResult,
  type SearchPage,
} from "../shared/rpc"
import { githubURL } from "../shared/url"
import type { BrowserHost } from "./context"

type Location = NonNullable<Plugin.Context["location"]>

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        retry: false,
        networkMode: "always",
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
      },
    },
  })
}

export function browserQueries(cache: QueryClient, client: BrowserHost["client"]) {
  const rpc = client.rpc(GitHub)
  const readKey = (location: Location, url: string, part: typeof Part.Type) => {
    const identity = githubURL(url)
    return ["github", location, "read", identity?.repository ?? url, identity?.number, part]
  }
  const withItemParts = (location: Location, item: Item): Item => {
    const comments = cache.getQueryData<ReadResult>(readKey(location, item.url, "comments"))
    const diff = cache.getQueryData<ReadResult>(readKey(location, item.url, "diff"))
    return {
      ...item,
      ...(comments?.part === "comments" ? { comments: comments.comments, commentsLoaded: true } : {}),
      ...(diff?.part === "diff" ? { files: diff.files } : {}),
    }
  }
  const withParts = <PageParam>(location: Location, data: InfiniteData<SearchPage, PageParam>) => ({
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => withItemParts(location, item)),
    })),
  })
  return {
    readState: (location: Location, url: string, part: typeof Part.Type) =>
      cache.getQueryState(readKey(location, url, part)),
    read: async (location: Location, url: string, part: typeof Part.Type, refresh: boolean, signal: AbortSignal) => {
      const options = {
        queryKey: readKey(location, url, part),
        queryFn: ({ signal }: QueryFunctionContext) =>
          rpc.read({ url, part, ...(refresh ? { refresh } : {}) }, { location, signal }),
        ...(refresh ? { staleTime: 0 } : {}),
      }
      const result = await observed(
        new QueryObserver(cache, { ...options, enabled: false }),
        () => cache.fetchQuery(options),
        signal,
      )
      return result.part === "details" ? { ...result, item: withItemParts(location, result.item) } : result
    },
    search: async (
      location: Location,
      query: string,
      kind: typeof Kind.Type,
      more: boolean,
      refresh: boolean,
      saved: Feed,
      signal: AbortSignal,
    ) => {
      const queryKey = ["github", location, "search", query, kind]
      const cached = cache.getQueryData<InfiniteData<SearchPage, number>>(queryKey)
      const count = saved.search?.page ?? 0
      if (more && cached && cached.pages.length > count) {
        signal.throwIfAborted()
        return withParts(location, {
          pages: cached.pages.slice(0, count + 1),
          pageParams: cached.pageParams.slice(0, count + 1),
        })
      }
      const options = {
        queryKey,
        queryFn: ({ signal, pageParam }: QueryFunctionContext<readonly unknown[], number>) =>
          rpc.search({ query, kind, page: pageParam, ...(refresh ? { refresh } : {}) }, { location, signal }),
        initialPageParam: 1,
        getNextPageParam: (last: SearchPage) =>
          last.page * SEARCH_PAGE_SIZE < Math.min(last.total, 1000) ? last.page + 1 : undefined,
        ...(refresh ? { staleTime: 0, pages: 1 } : {}),
      }
      const observer = new InfiniteQueryObserver(cache, { ...options, enabled: false })
      // Rebuild missing pages through the RPC so the query cache contains actual
      // paginated search responses, including when resuming a saved view.
      if (!more || !cached || cached.pages.length < count)
        return withParts(
          location,
          await observed(
            observer,
            () =>
              cache.fetchInfiniteQuery({
                ...options,
                ...(more ? { pages: count + 1, staleTime: 0 } : {}),
              }),
            signal,
          ),
        )
      const result = await observed(
        observer,
        () => observer.fetchNextPage({ throwOnError: true, cancelRefetch: false }),
        signal,
      )
      if (!result.data) throw new Error("Could not load the next page of GitHub results.")
      return withParts(location, result.data)
    },
  }
}

// Keep an observer attached only for this caller's request. Detaching the last observer
// cancels TanStack's RPC signal; another pane sharing the query can finish independently.
function observed<A>(
  observer: { subscribe: (listener: () => void) => () => void },
  fetch: () => Promise<A>,
  signal: AbortSignal,
): Promise<A> {
  signal.throwIfAborted()
  const unsubscribe = observer.subscribe(() => {})
  return new Promise<A>((resolve, reject) => {
    const abort = () => {
      unsubscribe()
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    fetch()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", abort)
        unsubscribe()
      })
  })
}
