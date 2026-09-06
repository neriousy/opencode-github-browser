import type { BrowserContext, BrowserHost } from "./context"
import type { KeymapCommand } from "@opencode-ai/plugin/tui/context"
import type { Plugin } from "@opencode-ai/plugin/tui"
import { CliRenderEvents, MouseButton, SyntaxStyle, TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { GitHub, SEARCH_PAGE_SIZE, errorMessage, type Feed, type Item } from "../shared/rpc"
import { Loading } from "./loading"
import { Hint } from "./hint"
import { ellipsis } from "./text"
import { PullRequestDiff } from "./diff"
import { GitHubMarkdown } from "./markdown"
import { markdownReferences } from "./markdown-text"
import { githubURL } from "../shared/url"
import type { QueryClient } from "@tanstack/query-core"
import { browserQueries, createQueryClient } from "./query"

const tabTitle = (kind: Item["kind"]) => (kind === "issue" ? "Issues" : "PRs")
const kindTitle = (kind: Item["kind"]) => (kind === "pr" ? "PR" : "Issue")

type HistoryEntry = { selected: string | null; index: number; scroll: number }
type View = HistoryEntry & {
  kind: "all" | "issue" | "pr"
  query: string
  diff: boolean
  history: HistoryEntry[]
  serverSelection: string | null
  serverNavigation?: number
}

export function Browser(props: {
  queryClient?: QueryClient
  context: BrowserHost
  sessionID?: string
  feed?: Feed
  focused?: boolean
  presentation?: "panel" | "fullscreen"
  close: () => void
  fullscreen?: () => void
  focus?: () => void
  width: number
  openTab: (item: Item, location: NonNullable<Plugin.Context["location"]>) => Promise<void>
  openURL: (url: string) => Promise<void>
}) {
  // The host paints split panels with its elevated tokens; match them so the pane reads as one surface.
  const context: BrowserContext = {
    get location() {
      return props.context.location
    },
    get theme() {
      return props.presentation === "panel" ? props.context.theme.contextual.elevated : props.context.theme
    },
    get client() {
      return props.context.client
    },
    get renderer() {
      return props.context.renderer
    },
    get storage() {
      return props.context.storage
    },
    get keymap() {
      return props.context.keymap
    },
    get data() {
      return props.context.data
    },
    get ui() {
      return props.context.ui
    },
  }
  const renderer = useRenderer()
  const queryClient = props.queryClient ?? createQueryClient()
  const queries = browserQueries(queryClient, context.client)
  onCleanup(() => {
    if (!props.queryClient) queryClient.clear()
  })
  const [paneWidth, setPaneWidth] = createSignal(props.width)
  // The host's chat column and sidebar use 2-cell gutters, tightening to 1 on narrow terminals.
  const gutter = () => (paneWidth() < 44 ? 1 : 2)
  const innerWidth = () => Math.max(1, paneWidth() - gutter() * 2)
  const [memory, updateMemory] = context.storage.memory<{ views: Record<string, View> }>("navigation.v2", {
    initial: { views: {} },
  })
  const focused = () => props.focused !== false
  const focusHint = () => context.keymap.shortcuts("pane.focus.right").join(" / ") || "/github"
  const location = () =>
    (props.sessionID ? context.data.session.get(props.sessionID)?.location : undefined) ??
    context.location ??
    context.data.location.default()
  const incoming = () => props.feed
  const [state, setState] = createStore<{
    feed: Feed
    selected: string | null
    kind: "all" | "issue" | "pr"
    query: string
    index: number
    busy: boolean
    loading: string
    error: string
    diff: boolean
    history: HistoryEntry[]
  }>({
    feed: { items: [], selected: null, note: "" },
    selected: null,
    kind: incoming() ? "all" : "issue",
    query: "",
    index: 0,
    busy: false,
    loading: incoming() ? "" : "Opening GitHub…",
    error: "",
    diff: false,
    history: [],
  })
  const items = createMemo(() =>
    state.feed.items.filter(
      (item) =>
        (state.kind === "all" || item.kind === state.kind) &&
        `${item.number} ${item.title} ${item.repository} ${item.labels.join(" ")}`
          .toLowerCase()
          .includes(state.query.toLowerCase()),
    ),
  )
  const repository = createMemo(() => {
    const repositories = new Set(state.feed.items.map((item) => item.repository))
    return repositories.size === 1 ? state.feed.items[0]?.repository : undefined
  })
  const selected = createMemo(() => state.feed.items.find((item) => item.url === state.selected))
  const activeTab = () => (!state.feed.search && state.feed.items.length ? undefined : state.kind)
  const tabs: Item["kind"][] = ["issue", "pr"]
  const mixed = createMemo(() => new Set(items().map((item) => item.kind)).size > 1)
  const numberWidth = createMemo(() => items().reduce((width, item) => Math.max(width, `#${item.number}`.length), 0))
  const filtered = () => !!state.query || (!state.feed.search && state.kind !== "all")
  const stateColor = (value: string) => {
    if (value === "open") return context.theme.text.feedback.success.default
    if (value === "merged") return context.theme.text.feedback.info.default
    if (value === "closed") return context.theme.text.feedback.error.default
    return context.theme.text.subdued
  }
  // The host's sidebar overlays a 1-cell track on reserved right padding so toggling it never reflows content.
  const scrollbar = () => ({
    position: "absolute" as const,
    right: 0,
    top: 0,
    width: 1,
    height: "100%" as const,
    trackOptions: {
      backgroundColor: context.theme.background.default,
      foregroundColor: context.theme.scrollbar.default,
    },
  })
  const syntax = SyntaxStyle.create()
  createEffect(() => {
    Object.entries(context.theme.syntax).forEach(([name, fg]) => syntax.registerStyle(name, { fg }))
    syntax.registerStyle("default", { fg: context.theme.text.default })
    syntax.registerStyle("markup.heading", {
      fg: context.theme.markdown.heading,
      bold: true,
    })
    syntax.registerStyle("markup.strong", {
      fg: context.theme.markdown.strong,
      bold: true,
    })
    syntax.registerStyle("markup.link", { fg: context.theme.markdown.link })
    syntax.registerStyle("markup.raw", { fg: context.theme.markdown.code })
    syntax.registerStyle("markup.italic", { fg: context.theme.markdown.emphasis, italic: true })
  })
  let list: ScrollBoxRenderable | undefined
  let content: ScrollBoxRenderable | undefined
  let pendingScroll = 0
  let restoreScroll: (() => void) | undefined
  const remember = (): HistoryEntry => ({
    selected: state.selected,
    index: state.index,
    scroll: state.selected ? (content?.scrollTop ?? 0) : (list?.scrollTop ?? 0),
  })
  const scrollTo = (offset: number) => {
    pendingScroll = offset
    if (restoreScroll) renderer.off(CliRenderEvents.FRAME, restoreScroll)
    // The previous document's height can clamp an early scroll to zero. Restore after layout.
    restoreScroll = () => {
      restoreScroll = undefined
      if (!disposed) (state.selected ? content : list)?.scrollTo(offset)
    }
    renderer.once(CliRenderEvents.FRAME, restoreScroll)
    renderer.requestRender()
  }
  const navigate = (url: string) => {
    if (url === state.selected) return
    cancel()
    pausedRead = undefined
    setState({ history: [...state.history, remember()], selected: url, diff: false, error: "" })
    scrollTo(0)
  }
  let disposed = false
  let pausedRead: string | null | undefined
  let request: { kind: "restore" | "read" | "search" | "action"; controller: AbortController } | undefined
  let retry: (() => void) | undefined
  const cancelRequest = () => {
    if (request?.kind === "read") pausedRead = state.selected
    request?.controller.abort()
    request = undefined
    setState({ loading: "", busy: false })
  }
  const cancelRestore = () => {
    if (request?.kind === "restore") cancelRequest()
  }
  const cancelRead = () => {
    if (request?.kind === "read") cancelRequest()
  }
  const cancel = () => {
    cancelRequest()
    if (restoreScroll) renderer.off(CliRenderEvents.FRAME, restoreScroll)
    restoreScroll = undefined
    setState({ busy: false, error: "", diff: state.diff && selected()?.files !== null })
  }
  const clearFilters = () => {
    setState({ query: "", index: 0, ...(state.feed.search ? {} : { kind: "all" }) })
    scrollTo(0)
  }
  onCleanup(() => {
    disposed = true
    request?.controller.abort()
    if (restoreScroll) renderer.off(CliRenderEvents.FRAME, restoreScroll)
    syntax.destroy()
  })
  const run = async (
    kind: NonNullable<typeof request>["kind"],
    loading: string,
    task: (signal: AbortSignal) => Promise<void>,
    again: () => void,
  ) => {
    request?.controller.abort()
    const current = { kind, controller: new AbortController() }
    request = current
    retry = again
    setState({ busy: true, loading, error: "" })
    try {
      await task(current.controller.signal)
    } catch (error) {
      if (!disposed && !current.controller.signal.aborted)
        setState({ error: errorMessage(error), ...(kind === "read" ? { diff: false } : {}) })
    } finally {
      if (!disposed && request === current) {
        request = undefined
        setState({ busy: false, loading: "" })
      }
    }
  }
  const perform = (task: () => Promise<void>) => {
    if (state.busy) return
    return run("action", "", task, () => void perform(task))
  }
  let activeSession: string | undefined
  let hydratedSession: string | undefined
  let serverSelection: string | null = null
  let serverNavigation: number | undefined
  const saveView = () => {
    const sessionID = props.sessionID
    if (!sessionID || hydratedSession !== sessionID) return
    const view: View = {
      ...remember(),
      kind: state.kind,
      query: state.query,
      diff: state.diff,
      history: state.history.map((entry) => ({ ...entry })),
      serverSelection,
      serverNavigation,
    }
    updateMemory((draft) => {
      draft.views[sessionID] = view
    })
  }
  const apply = (feed: Feed) => {
    if ((feed.revision ?? 0) < (state.feed.revision ?? 0)) return
    const highlighted = items()[state.index]?.url
    const initial = hydratedSession !== props.sessionID
    const explicit = (serverNavigation ?? 0) !== (feed.navigation ?? 0)
    const requested = explicit || (initial && serverSelection !== feed.selected) ? feed.selected : state.selected
    const identity = requested ? githubURL(requested) : undefined
    const selection =
      feed.items.find((item) => item.url === requested)?.url ??
      feed.items.find((item) => identity && item.repository === identity.repository && item.number === identity.number)
        ?.url ??
      null
    serverSelection = feed.selected
    serverNavigation = feed.navigation
    if (selection && selection !== state.selected && state.feed.items.length) {
      const previous = state.selected ? githubURL(state.selected) : undefined
      if (!previous || previous.repository !== identity?.repository || previous.number !== identity?.number)
        navigate(selection)
    }
    if (explicit) setState({ diff: false, ...(selection ? {} : { history: [] }) })
    setState({
      feed,
      selected: feed.items.some((item) => item.url === selection) ? selection : null,
      // A server search already scoped the results; the tab must reflect it.
      kind: feed.search?.kind ?? "all",
    })
    setState(
      "index",
      highlighted
        ? Math.max(
            0,
            items().findIndex((item) => item.url === highlighted),
          )
        : Math.min(state.index, Math.max(0, items().length - 1)),
    )
    hydratedSession = props.sessionID
    saveView()
  }
  const restore = (sessionID: string) =>
    run(
      "restore",
      "Opening GitHub…",
      async (signal) => {
        const saved = await context.client.rpc(GitHub).current({ sessionID }, { location: location(), signal })
        if (disposed || signal.aborted) return
        if (saved) {
          apply(saved)
          return
        }
        await searchRequest("is:open", "issue")
      },
      () => void restore(sessionID),
    )
  createEffect(() => {
    const feed = incoming()
    const sessionID = props.sessionID
    if (activeSession !== sessionID)
      untrack(() => {
        activeSession = sessionID
        hydratedSession = undefined
        const saved = sessionID ? memory.views[sessionID] : undefined
        serverSelection = saved?.serverSelection ?? null
        serverNavigation = saved?.serverNavigation
        pendingScroll = saved?.scroll ?? 0
        cancel()
        pausedRead = undefined
        retry = undefined
        setState({
          feed: { items: [], selected: null, note: "" },
          selected: saved?.selected ?? null,
          diff: saved?.diff ?? false,
          query: saved?.query ?? "",
          index: saved?.index ?? 0,
          kind: saved?.kind ?? (feed ? "all" : "issue"),
          error: "",
          loading: feed ? "" : "Opening GitHub…",
          history: saved?.history ?? [],
        })
      })
    if (feed)
      return untrack(() => {
        cancelRestore()
        apply(feed)
      })
    if (!sessionID) return untrack(() => void searchRequest("is:open", "issue"))
    untrack(() => void restore(sessionID))
  })
  // Persist navigation, not just server selection, when switching sessions or reopening the panel.
  createEffect(
    on(
      () => [props.sessionID, state.selected, state.index, state.kind, state.query, state.diff, state.history],
      saveView,
    ),
  )
  onCleanup(saveView)
  const searchRequest = (query: string, kind: "all" | "issue" | "pr", page = 1, refresh = false) =>
    run(
      "search",
      `${refresh ? "Refreshing" : "Loading"} ${kind === "pr" ? "pull requests" : kind === "issue" ? "issues" : "results"}…`,
      async (signal) => {
        const target = location()
        const sessionID =
          props.sessionID ??
          (await context.client.session.create({ title: `GitHub · ${query}`, location: target }, { signal })).id
        if (disposed || signal.aborted) return
        const data = await queries.search(target, query, kind, page > 1, refresh, state.feed, signal)
        if (disposed || signal.aborted) return
        const feed = await context.client
          .rpc(GitHub)
          .saveSearch({ sessionID, pages: data.pages, text: query, navigate: page === 1 }, { location: target, signal })
        if (disposed || signal.aborted) return
        if (page === 1) {
          setState({ query: refresh ? state.query : "", kind })
          if (!refresh) scrollTo(0)
        }
        apply(feed)
        if (!props.sessionID) {
          await context.data.session.sync(sessionID)
          if (disposed || signal.aborted) return
          context.ui.tabs.open(sessionID)
          context.ui.router.navigate({ type: "session", sessionID })
          context.ui.panel.open("github-browser.issues")
          queueMicrotask(() => context.keymap.dispatch("pane.focus.right"))
        }
      },
      () => void searchRequest(query, kind, page, true),
    )
  const search = async () => {
    const query = await context.ui.dialog.prompt({
      title: "Search GitHub",
      description: "Search this project’s GitHub repository. Use repo:owner/repo, org:, or user: to search elsewhere.",
      value: state.feed.search?.text ?? state.feed.search?.query,
      placeholder: "is:open label:bug",
    })
    if (query?.trim()) await searchRequest(query.trim(), state.kind === "pr" ? "pr" : "issue")
  }
  const changeKind = (kind: Item["kind"]) => {
    if (kind === activeTab()) return
    const search = state.feed.search
    return searchRequest(search?.text ?? search?.query ?? "is:open", kind)
  }
  const nextKind = () => {
    const available = tabs
    const next = available[(available.findIndex((kind) => kind === activeTab()) + 1) % available.length]
    if (next) return changeKind(next)
  }
  const hasMore = () =>
    !!state.feed.search && state.feed.search.page * SEARCH_PAGE_SIZE < Math.min(state.feed.search.total, 1000)
  const more = () => {
    const search = state.feed.search
    if (search && hasMore()) return searchRequest(search.text ?? search.query, search.kind, search.page + 1)
  }
  const filter = async () => {
    const query = await context.ui.dialog.prompt({
      title: "Filter displayed results",
      value: state.query,
      placeholder: "Title, number, repository, or label",
    })
    if (query !== undefined) {
      setState({ query, selected: null, index: 0, diff: false, history: [] })
      scrollTo(0)
    }
  }
  const fetch = (part: "details" | "comments" | "diff", item = selected(), refresh = true) => {
    const sessionID = props.sessionID
    if (!item || !sessionID || state.loading) return
    if (part === "diff") setState("diff", true)
    return run(
      "read",
      `${refresh ? "Refreshing" : "Loading"} ${part} for #${item.number}…`,
      async (signal) => {
        const target = location()
        const result = await queries.read(target, item.url, part, refresh, signal)
        if (disposed || signal.aborted) return
        const feed = await context.client.rpc(GitHub).saveRead({ sessionID, result }, { location: target, signal })
        if (!disposed && !signal.aborted) apply(feed)
      },
      () => void fetch(part, item, true),
    )
  }
  // Search results already carry the description; only bare URL references need details.
  createEffect(() => {
    const item = selected()
    const sessionID = props.sessionID
    const loading = state.loading
    if (!item || !sessionID || loading || state.error || item.bodyLoaded || pausedRead === item.url) return
    const cached = queries.readState(location(), item.url, "details")
    if (cached?.status === "error")
      return untrack(() => {
        retry = () => void fetch("details", item, true)
        setState("error", errorMessage(cached.error))
      })
    untrack(() => void fetch("details", item, false))
  })
  const openURL = async () => {
    const url = await context.ui.dialog.prompt({
      title: "Open GitHub issue or pull request",
      placeholder: "https://github.com/owner/repo/issues/123",
    })
    if (url?.trim()) await perform(() => props.openURL(url.trim()))
  }
  const tab = (item?: Item) => (item ? perform(() => props.openTab(item, location())) : undefined)
  const preview = (item?: Item) => {
    if (item) navigate(item.url)
  }
  const move = (offset: number) => {
    setState("index", Math.max(0, Math.min(items().length - 1, state.index + offset)))
    list?.scrollChildIntoView(`github-item-${state.index}`)
  }
  const back = () => {
    if (state.loading) return cancel()
    if (state.diff) return setState("diff", false)
    cancelRead()
    pausedRead = undefined
    const previous = state.history.at(-1)
    if (previous) {
      const selected = state.feed.items.some((item) => item.url === previous.selected) ? previous.selected : null
      setState({ selected, index: previous.index, history: state.history.slice(0, -1) })
      scrollTo(previous.scroll)
      return
    }
    if (state.selected) {
      setState("selected", null)
      scrollTo(0)
      return
    }
    props.close()
  }
  const scroll = (amount: number | "start" | "end") => {
    const target = state.selected ? content : list
    if (!target) return
    if (amount === "start" || amount === "end") {
      if (!state.selected) setState("index", amount === "start" ? 0 : Math.max(0, items().length - 1))
      target.scrollTo(amount === "start" ? 0 : target.scrollHeight)
    } else target.scrollBy(amount)
  }
  const page = (direction: number) => {
    if (!state.selected) return move(direction * Math.max(1, Math.floor((list?.height ?? 20) / 2)))
    scroll(direction * Math.max(1, content?.height ?? 10) * 0.8)
  }
  const neighbor = (direction: number) => {
    const index = items().findIndex((item) => item.url === state.selected)
    const next = items()[index + direction]
    if (next) preview(next)
  }
  const viewDiff = () => {
    if (selected()?.files === null) return fetch("diff", selected(), false)
    setState("diff", true)
  }
  // Other issues and PRs mentioned in the loaded discussion; drives the references command and its footer hint.
  const references = createMemo(() => {
    const item = selected()
    if (!item) return []
    return markdownReferences(
      [item.body, ...item.comments.map((comment) => comment.body)],
      item.repository,
      syntax,
    ).filter((reference) => reference.repository !== item.repository || reference.number !== item.number)
  })
  const help = async () => {
    const command = await context.ui.dialog.select({
      title: "GitHub actions",
      options: ["Browse", "Item", "View"]
        .flatMap((group) => commands().filter((command) => command.group === group))
        .filter(
          (command) =>
            command.title && command.enabled !== false && (selected() || command.id !== "github-browser.back"),
        )
        .map((command) => ({
          title: command.title ?? "",
          category: command.group,
          description: typeof command.bind === "string" ? command.bind : undefined,
          value: command,
        })),
    })
    await command?.run()
  }
  const commands = createMemo<KeymapCommand[]>(() => [
    {
      id: "github-browser.refresh-search",
      group: "Browse",
      title: "Refresh search results",
      bind: "l",
      enabled: !selected() && !!state.feed.search,
      run: () => {
        const search = state.feed.search
        if (search) return searchRequest(search.text ?? search.query, search.kind, 1, true)
      },
    },
    {
      id: "github-browser.repository",
      group: "Browse",
      title: "Current repository issues",
      bind: "i",
      run: () => searchRequest("is:open", "issue"),
    },
    {
      id: "github-browser.retry",
      group: "Browse",
      title: "Retry GitHub request",
      bind: "r",
      enabled: !!state.error && !state.loading,
      run: () => retry?.(),
    },
    {
      id: "github-browser.clear-filters",
      group: "Browse",
      title: "Clear displayed-result filters",
      bind: "x",
      enabled: !selected() && filtered(),
      run: clearFilters,
    },
    {
      id: "github-browser.open-url",
      group: "Browse",
      title: "Open GitHub URL",
      bind: "o",
      run: openURL,
    },
    {
      id: "github-browser.back",
      group: "View",
      title: state.diff
        ? "Back to details"
        : state.history.at(-1)?.selected
          ? "Back to previous item"
          : "Back to results",
      bind: "escape,backspace,left",
      run: back,
    },
    { id: "github-browser.close", group: "View", title: "Close GitHub panel", bind: "q", run: props.close },
    {
      id: "github-browser.search",
      group: "Browse",
      title: "Search GitHub directly",
      bind: "/",
      run: search,
    },
    {
      id: "github-browser.more",
      group: "Browse",
      title: "Load more search results",
      bind: "m",
      enabled: !selected() && hasMore(),
      run: more,
    },
    {
      id: "github-browser.filter",
      group: "Browse",
      title: "Filter displayed results",
      bind: "s",
      enabled: !selected(),
      run: filter,
    },
    {
      id: "github-browser.kind",
      group: "Browse",
      title: "Switch issues / PRs",
      bind: "tab",
      enabled: !selected(),
      run: nextKind,
    },
    { bind: "up,k", enabled: !state.diff, run: () => (selected() ? scroll(-1) : move(-1)) },
    { bind: "down,j", enabled: !state.diff, run: () => (selected() ? scroll(1) : move(1)) },
    { bind: "pageup", enabled: !state.diff, run: () => page(-1) },
    { bind: "pagedown", enabled: !state.diff, run: () => page(1) },
    { bind: "home", enabled: !state.diff, run: () => scroll("start") },
    { bind: "end", enabled: !state.diff, run: () => scroll("end") },
    { bind: "n", enabled: !!selected() && !state.diff, title: "Next result", group: "Item", run: () => neighbor(1) },
    {
      bind: "p",
      enabled: !!selected() && !state.diff,
      title: "Previous result",
      group: "Item",
      run: () => neighbor(-1),
    },
    {
      id: "github-browser.select",
      group: "Item",
      title: "Open item in panel",
      bind: "enter,right",
      enabled: !selected(),
      run: () => preview(items()[state.index]),
    },
    {
      id: "github-browser.tab",
      group: "Item",
      title: "Open conversation about this item",
      bind: "t",
      enabled: !!selected() || items().length > 0,
      run: () => tab(selected() ?? items()[state.index]),
    },
    {
      id: "github-browser.preview",
      title: "Open item in panel",
      bind: "p",
      enabled: !selected(),
      run: () => preview(items()[state.index]),
    },
    {
      id: "github-browser.diff",
      group: "Item",
      title: "View PR diff",
      bind: "v",
      enabled: selected()?.kind === "pr" && !state.diff,
      run: viewDiff,
    },
    {
      id: "github-browser.details",
      group: "Item",
      title: "Refresh GitHub details",
      bind: "l",
      enabled: !!selected(),
      run: () => fetch(state.diff ? "diff" : "details"),
    },
    {
      id: "github-browser.comments",
      group: "Item",
      title: "Load GitHub comments",
      bind: "c",
      enabled: !!selected() && !state.diff,
      run: () => fetch("comments", selected(), selected()?.commentsLoaded ?? false),
    },
    {
      id: "github-browser.references",
      group: "Item",
      title: "Referenced issues / PRs",
      bind: "r",
      enabled: !state.diff && !state.error && references().length > 0,
      run: async () => {
        if (!references().length) return
        const url = await context.ui.dialog.select({
          title: "Referenced issues / PRs",
          options: references().map((reference) => ({ title: reference.title, value: reference.url })),
        })
        if (disposed || !url) return
        await perform(() => props.openURL(url))
      },
    },
    {
      id: "github-browser.fullscreen",
      group: "View",
      title: "Toggle fullscreen",
      bind: "f",
      enabled: !!props.fullscreen,
      run: props.fullscreen ?? (() => {}),
    },
  ])
  context.keymap.layer(() => ({
    enabled: focused(),
    commands: [...commands(), { bind: "?", title: "GitHub actions", run: help }],
  }))
  // The footer is the one place for shortcuts, like the host's prompt footer; the header only describes the view.
  const footerHints = (): { keys: string; label: string; run?: () => void }[] => {
    const hints = (() => {
      if (state.diff)
        return [
          { keys: "esc", label: "back", run: back },
          { keys: "[ ]", label: "files" },
          { keys: "c", label: "pick file" },
          { keys: "v", label: "layout" },
        ]
      if (selected())
        return [
          { keys: "esc", label: "back", run: back },
          ...(references().length
            ? [{ keys: "r", label: "references", run: () => context.keymap.dispatch("github-browser.references") }]
            : []),
        ]
      if (!items().length)
        return [
          { keys: "/", label: "search", run: () => void search() },
          { keys: "o", label: "open URL", run: () => void openURL() },
          { keys: "esc", label: "close", run: props.close },
        ]
      return [
        { keys: "↵", label: "open", run: () => preview(items()[state.index]) },
        { keys: "/", label: "search", run: () => void search() },
        ...(hasMore() ? [{ keys: "m", label: "more", run: () => void more() }] : []),
        { keys: "esc", label: "close", run: props.close },
      ]
    })()
    // Drop trailing hints rather than clipping one mid-word; "? actions" always keeps its place on the right.
    const available = innerWidth() - "? actions".length - 2
    let used = 0
    return hints.filter((hint, index) => {
      used += hint.keys.length + 1 + hint.label.length + (index ? 2 : 0)
      return used <= available
    })
  }

  return (
    <box
      width="100%"
      height="100%"
      minWidth={0}
      overflow="hidden"
      onSizeChange={function () {
        setPaneWidth(this.width)
      }}
      flexDirection="column"
      backgroundColor={context.theme.background.default}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={gutter()}
      paddingRight={gutter()}
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT) props.focus?.()
      }}
    >
      <box flexShrink={0}>
        <Show when={selected()}>
          <text fg={context.theme.text.action.secondary.default} onMouseUp={back} selectable={false}>
            ←{" "}
            {state.diff
              ? "Back to details"
              : state.history.at(-1)?.selected
                ? "Back to previous item"
                : "Back to results"}
          </text>
        </Show>
        <Show when={selected()?.repository ?? repository() ?? state.feed.search?.query ?? "Current repository"}>
          {(label) => (
            <box flexDirection="row" justifyContent="space-between" height={1} gap={2}>
              <box flexDirection="row" flexShrink={1} minWidth={0}>
                <text
                  fg={context.theme.text.default}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                  truncate
                  flexShrink={1}
                  minWidth={0}
                >
                  {label()}
                </text>
                <Show when={!selected() && repository() ? state.feed.search : undefined}>
                  {(search) => (
                    <text fg={context.theme.text.subdued} wrapMode="none" truncate flexShrink={1} minWidth={0}>
                      {` · ${search().text ?? search().query.replace(/^repo:\S+\s*/, "")}`}
                    </text>
                  )}
                </Show>
              </box>
              <Show when={!selected() && (!state.loading || state.feed.items.length > 0)}>
                <text fg={context.theme.text.subdued} wrapMode="none" flexShrink={0}>
                  {state.feed.search ? `${items().length} of ${state.feed.search.total}` : `${items().length} selected`}
                </text>
              </Show>
            </box>
          )}
        </Show>
        <Show when={state.diff && selected()}>
          {(item) => (
            <text fg={context.theme.text.default} attributes={TextAttributes.BOLD} wrapMode="word">
              PR #{item().number} · {item().title}
            </text>
          )}
        </Show>
        <Show when={!selected()}>
          <box flexDirection="row" gap={2} height={1}>
            <For each={tabs}>
              {(kind) => (
                <text
                  fg={activeTab() === kind ? context.theme.text.default : context.theme.text.subdued}
                  attributes={activeTab() === kind ? TextAttributes.BOLD : undefined}
                  onMouseUp={() => void changeKind(kind)}
                  selectable={false}
                >
                  {tabTitle(kind)}
                </text>
              )}
            </For>
          </box>
        </Show>
        <Show when={state.query}>
          <box flexDirection="row" justifyContent="space-between" height={1} gap={2}>
            <text fg={context.theme.text.subdued} wrapMode="none" truncate flexShrink={1} minWidth={0}>
              Filter: {state.query}
            </text>
            <Hint theme={context.theme} keys="x" label="clear" onMouseUp={clearFilters} />
          </box>
        </Show>
      </box>
      <Show when={state.error}>
        <box flexShrink={0} paddingTop={1} gap={1}>
          <text fg={context.theme.text.feedback.error.default} wrapMode="word">
            {state.error}
          </text>
          <Show when={retry}>
            <Hint theme={context.theme} keys="r" label="retry" onMouseUp={() => retry?.()} />
          </Show>
        </box>
      </Show>
      <box height={1} flexShrink={0} width="100%" overflow="hidden">
        <Show when={state.loading || state.busy}>
          <Loading
            theme={context.theme}
            label={
              paneWidth() < 45 && state.loading
                ? state.loading.startsWith("Refreshing")
                  ? "Refreshing…"
                  : "Loading…"
                : state.loading || "Working…"
            }
            cancel={cancel}
          />
        </Show>
      </box>
      <Show
        when={selected()}
        fallback={
          <Show
            when={items().length}
            fallback={
              <box flexGrow={1} flexBasis={0} minHeight={0} width="100%" overflow="hidden" gap={1} paddingTop={1}>
                <Show when={!state.loading}>
                  <text fg={context.theme.text.subdued} wrapMode="word">
                    {state.feed.items.length
                      ? "No displayed results match this filter"
                      : state.feed.search
                        ? "No GitHub results for this query"
                        : "Search GitHub or open an issue/PR link"}
                  </text>
                  <text fg={context.theme.text.subdued} wrapMode="word">
                    Read descriptions, discussions, and PR diffs here. Searches default to this project’s repository.
                  </text>
                </Show>
              </box>
            }
          >
            <scrollbox
              ref={(value) => {
                list = value
                queueMicrotask(() => {
                  if (!disposed) scrollTo(pendingScroll)
                })
              }}
              flexGrow={1}
              flexBasis={0}
              minHeight={0}
              width="100%"
              scrollX={false}
              verticalScrollbarOptions={scrollbar()}
              contentOptions={{ gap: 0, minWidth: 0, width: "100%", paddingRight: 1 }}
            >
              <For each={items()}>
                {(item, index) => {
                  const current = () => state.index === index()
                  // The cursor row uses the host's quiet hover step, like its file trees, not the loud accent.
                  const background = () =>
                    focused() && current()
                      ? context.theme.background.action.primary.hovered
                      : context.theme.background.default
                  const meta = () =>
                    [
                      mixed() ? kindTitle(item.kind) : "",
                      !repository() ? item.repository : "",
                      ...item.labels,
                      item.author ? `@${item.author}` : "",
                    ].filter(Boolean)
                  const indent = () => numberWidth() + 2
                  return (
                    <box
                      id={`github-item-${index()}`}
                      flexShrink={0}
                      width="100%"
                      minWidth={0}
                      backgroundColor={background()}
                      onSizeChange={() => {
                        if (current())
                          queueMicrotask(() => {
                            if (!disposed) list?.scrollChildIntoView(`github-item-${index()}`)
                          })
                      }}
                      onMouseOver={() => {
                        if (focused()) setState("index", index())
                      }}
                      onMouseUp={(event) => {
                        if (event.button === MouseButton.LEFT && !context.renderer.getSelection()?.getSelectedText())
                          preview(item)
                      }}
                    >
                      <box flexDirection="row" width="100%" minWidth={0} flexShrink={0}>
                        <text
                          flexShrink={0}
                          wrapMode="none"
                          fg={context.theme.text.subdued}
                        >{`${`#${item.number}`.padStart(numberWidth())}  `}</text>
                        <text
                          fg={context.theme.text.default}
                          attributes={current() ? TextAttributes.BOLD : undefined}
                          flexGrow={1}
                          flexShrink={1}
                          minWidth={0}
                          wrapMode="word"
                        >
                          {current() ? item.title : ellipsis(item.title, innerWidth() - indent() - 1)}
                        </text>
                      </box>
                      <text height={1} flexShrink={0} wrapMode="none" width="100%">
                        <span>{" ".repeat(indent())}</span>
                        <span style={{ fg: stateColor(item.state) }}>{`• ${item.state}`}</span>
                        <span style={{ fg: context.theme.text.subdued }}>
                          {meta().length
                            ? ` · ${ellipsis(meta().join(" · "), innerWidth() - indent() - item.state.length - 6)}`
                            : ""}
                        </span>
                      </text>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
        }
      >
        {(item) => (
          <Show
            when={state.diff && item().files !== null}
            fallback={
              <scrollbox
                ref={(value) => {
                  content = value
                  queueMicrotask(() => {
                    if (!disposed) scrollTo(pendingScroll)
                  })
                }}
                flexGrow={1}
                flexBasis={0}
                minHeight={0}
                width="100%"
                scrollX={false}
                verticalScrollbarOptions={scrollbar()}
                wrapperOptions={{ flexBasis: 0, flexShrink: 1, minWidth: 0 }}
                contentOptions={{ gap: 1, paddingBottom: 1, paddingRight: 1, width: "100%", minWidth: 0 }}
              >
                <text wrapMode="word">
                  <span
                    style={{ fg: context.theme.text.subdued }}
                  >{`${kindTitle(item().kind)} #${item().number}  `}</span>
                  <b style={{ fg: context.theme.text.default }}>{item().title}</b>
                </text>
                <text wrapMode="word">
                  <span style={{ fg: stateColor(item().state) }}>{`• ${item().state}`}</span>
                  <span style={{ fg: context.theme.text.subdued }}>
                    {[`@${item().author}`, ...item().labels].map((part) => ` · ${part}`).join("")}
                  </span>
                </text>
                <text fg={context.theme.markdown.link} wrapMode="word">
                  <a href={item().url}>{item().url}</a>
                </text>
                <Show when={item().kind === "pr"}>
                  <Hint
                    theme={context.theme}
                    keys="v"
                    label={item().files === null ? "Load diff" : "View diff"}
                    onMouseUp={() => void viewDiff()}
                  />
                </Show>
                <Show when={item().bodyLoaded}>
                  <GitHubMarkdown
                    syntax={syntax}
                    repository={item().repository}
                    content={item().body || "No description provided."}
                    context={context}
                    location={location()}
                  />
                </Show>
                <text fg={context.theme.text.default}>
                  <b>Discussion</b>
                  <span style={{ fg: context.theme.text.subdued }}>
                    {` · ${item().commentsLoaded ? `${item().comments.length} comments` : "comments not loaded"}`}
                  </span>
                </text>
                <Show when={item().commentsLoaded && !item().comments.length}>
                  <text fg={context.theme.text.subdued}>No discussion comments yet</text>
                </Show>
                <For each={item().comments}>
                  {(comment) => (
                    <box gap={1}>
                      <text fg={context.theme.text.default} attributes={TextAttributes.BOLD}>
                        @{comment.author}
                      </text>
                      <GitHubMarkdown
                        syntax={syntax}
                        repository={item().repository}
                        content={comment.body}
                        context={context}
                        location={location()}
                      />
                    </box>
                  )}
                </For>
                <Hint
                  theme={context.theme}
                  keys="c"
                  label={`${item().commentsLoaded ? "Refresh" : "Load"} comments`}
                  onMouseUp={() => void fetch("comments", selected(), selected()?.commentsLoaded ?? false)}
                />
              </scrollbox>
            }
          >
            <PullRequestDiff
              context={context}
              files={item().files ?? []}
              syntax={syntax}
              focused={focused() && !state.busy}
              width={props.width}
            />
          </Show>
        )}
      </Show>
      <box flexShrink={0} paddingTop={1}>
        <Show
          when={focused()}
          fallback={
            <text fg={context.theme.text.subdued} height={1} wrapMode="none" truncate>
              Inactive · click or {focusHint()} to focus
            </text>
          }
        >
          <box flexDirection="row" justifyContent="space-between" height={1} gap={2}>
            <box flexDirection="row" gap={2} flexShrink={1} minWidth={0} overflow="hidden">
              <For each={footerHints()}>
                {(hint) => <Hint theme={context.theme} keys={hint.keys} label={hint.label} onMouseUp={hint.run} />}
              </For>
            </box>
            <Hint theme={context.theme} keys="?" label="actions" onMouseUp={() => void help()} />
          </box>
        </Show>
      </box>
    </box>
  )
}
