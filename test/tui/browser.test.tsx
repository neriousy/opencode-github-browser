import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import { DEFAULT_THEME, resolveThemeDocument } from "@opencode-ai/theme/tui"
import type { KeymapLayer } from "@opencode-ai/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { BoxRenderable, ImageRenderable, Renderable, TextRenderable, TextAttributes } from "@opentui/core"
import { createSignal, For, Show } from "solid-js"
import { Effect, Layer, Schema } from "effect"
import { createStore, produce } from "solid-js/store"
import { Browser } from "../../src/tui/browser"
import type { BrowserHost } from "../../src/tui/context"
import { GitHub, Kind, ReadResult, SearchPage, Feed } from "../../src/shared/rpc"
import { FeedStore, FeedStorage } from "../../src/server/store"
import { openView, readView, searchView } from "../../src/server/view"
import { reference } from "../../src/shared/url"
import { linkAt, registerLinks } from "../../src/tui/links"
import { browserQueries, createQueryClient } from "../../src/tui/query"
import { detailFeed, emptyFeed, searchFeed } from "../fixtures"

function fixture(
  feed: Feed,
  response: (request: Request) => Promise<Response> = async () => Response.json({ output: feed }),
) {
  const layers: (() => KeymapLayer)[] = []
  const prompts: string[] = []
  const choices: string[] = []
  const menus: string[][] = []
  const menuGroups: (string | undefined)[][] = []
  const navigated: string[] = []
  const synced: string[] = []
  const openedTabs: string[] = []
  const values = new Map<string, Schema.Json>()
  const storage = Layer.succeed(FeedStorage)({
    get: (key) => Effect.sync(() => values.get(key) ?? { feed, pinned: null }),
    set: (key, value) =>
      Effect.sync(() => {
        values.set(key, value)
      }),
  })
  const save = async (request: Request) => {
    const method = new URL(request.url).pathname.split("/").at(-1)
    if (method !== "saveRead" && method !== "saveSearch" && method !== "open") return response(request)
    const input = await request.json()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* FeedStore
          if (method === "open") {
            const { input: data } = Schema.decodeUnknownSync(
              Schema.Struct({ input: Schema.Struct({ sessionID: Schema.String, url: Schema.String }) }),
            )(input)
            return yield* store.update(data.sessionID, (snapshot) => openView(snapshot, reference(data.url)), {
              reveal: true,
            })
          }
          if (method === "saveRead") {
            const { input: data } = Schema.decodeUnknownSync(
              Schema.Struct({ input: Schema.Struct({ sessionID: Schema.String, result: ReadResult }) }),
            )(input)
            return yield* store.update(data.sessionID, (snapshot) => readView(snapshot, data.result))
          }
          const { input: data } = Schema.decodeUnknownSync(
            Schema.Struct({
              input: Schema.Struct({
                sessionID: Schema.String,
                pages: Schema.Array(SearchPage),
                text: Schema.String,
                navigate: Schema.Boolean,
              }),
            }),
          )(input)
          return yield* store.update(data.sessionID, (snapshot) => searchView(snapshot, data.pages, data.text), {
            reveal: data.navigate,
          })
        }).pipe(Effect.provide(FeedStore.layer), Effect.provide(storage)),
      ),
    )
    return Response.json({ output: result })
  }
  const client = OpenCode.make({
    baseUrl: "http://fixture.invalid",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => save(new Request(input, init)), {
      preconnect: () => {},
    }),
  })
  const context: BrowserHost = {
    location: { directory: "/fixture" },
    client,
    renderer: { getSelection: () => null },
    theme: resolveThemeDocument(DEFAULT_THEME, "dark"),
    storage: {
      memory: <T extends object>(_key: string, options: { initial: T }) => {
        const [state, setState] = createStore(options.initial)
        return [
          state,
          (mutate: (draft: T) => void) => {
            setState(produce(mutate))
          },
        ]
      },
    },
    keymap: {
      layer: (layer) => {
        layers.push(layer)
      },
      shortcuts: () => [],
      dispatch: () => false,
    },
    data: {
      session: {
        get: () => undefined,
        sync: async (id) => {
          synced.push(id)
        },
      },
      location: { default: () => ({ directory: "/fixture" }) },
    },
    ui: {
      dialog: {
        prompt: async () => prompts.shift(),
        select: async (options) => {
          menus.push(options.options.map((option) => option.title))
          menuGroups.push(options.options.map((option) => option.category))
          const choice = choices.shift()
          return options.options.find((option) => option.title === choice)?.value
        },
      },
      toast: { show: () => {} },
      tabs: {
        open: (id) => {
          openedTabs.push(id)
          return true
        },
      },
      panel: { open: () => true },
      router: {
        navigate: (route) => {
          if (route.type === "session") navigated.push(route.sessionID)
        },
      },
    },
  }
  return {
    context,
    values,
    prompts,
    choices,
    menus,
    menuGroups,
    navigated,
    synced,
    openedTabs,
    async key(bind: string) {
      const enabled = (value: KeymapLayer["enabled"]) => (typeof value === "function" ? value() : value !== false)
      const command = layers
        .flatMap((get) => {
          const layer = get()
          return enabled(layer.enabled) ? (layer.commands ?? []) : []
        })
        .find(
          (command) =>
            typeof command.bind === "string" && command.bind.split(",").includes(bind) && enabled(command.enabled),
        )
      await command?.run()
    },
  }
}

const issue = {
  ...reference("https://github.com/owner/repo/issues/42"),
  title: "Keep GitHub inside the terminal",
  body: "A description to read in OpenCode.",
  bodyLoaded: true,
  commentsLoaded: true,
}
const pr = {
  ...reference("https://github.com/owner/repo/pull/43"),
  title: "Improve the reader",
  bodyLoaded: true,
  files: [
    { filename: "src/reader.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
  ],
}

const imageData =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAIAAAD4YuoOAAAAHUlEQVR4nGO4E2BEU8QwasGoBaMWjFowasFQsAAAtnW8H7+HOxMAAAAASUVORK5CYII="

function textNodes(node: Renderable): TextRenderable[] {
  return node
    .getChildren()
    .flatMap((child) =>
      child instanceof TextRenderable ? [child] : child instanceof Renderable ? textNodes(child) : [],
    )
}

for (const width of [32, 100]) {
  test(`Markdown discussion styles, wraps and links references at ${width} columns`, async () => {
    const item = {
      ...issue,
      body: "## Environment\n\n**Bold _and italic_** with ~~old~~ and `#900`.\n\n- [x] Done\n- See #43 and other/project#12.\n\n| Related | Status |\n| --- | --- |\n| #44 | Ready |",
      comments: [
        {
          id: "1",
          author: "reviewer",
          body: "> Duplicates:\n> - **#45** is related.\n> - <https://github.com/other/project/pull/46?email_token=fixture>\n\n[More context](https://github.com/owner/repo/issues/47) &amp; \\#901.\n\n[External #902](https://example.com)\n\n```ts\nconst example = '#903'\n```",
        },
      ],
    }
    const feed = detailFeed(item)
    const app = fixture(feed)
    const opened: string[] = []
    const rendered = await testRender(
      () => (
        <Browser
          context={app.context}
          feed={feed}
          focused
          width={width}
          close={() => {}}
          openURL={async () => {}}
          openTab={async () => {}}
        />
      ),
      { width, height: 65 },
    )
    const stop = registerLinks(rendered.renderer, (url) => opened.push(url))
    try {
      const frame = await rendered.waitForFrame((frame) => frame.includes("More context") && frame.includes("example"))
      expect(frame).not.toContain("https://github.com/other")
      expect(frame).not.toContain("https://github.com/owner/repo/issues/47")
      expect(frame).not.toContain("email_token")
      expect(frame).not.toContain("**")
      expect(frame).toContain("☑ Done")
      expect(frame).toContain("• See #43")
      expect(frame).toContain("other/project#46")
      const chunks = textNodes(rendered.renderer.root).flatMap((text) => text.chunks)
      expect(chunks.find((chunk) => chunk.text === "Environment")?.attributes ?? 0).toBe(TextAttributes.BOLD)
      expect(chunks.find((chunk) => chunk.text === "and italic")?.attributes ?? 0).toBe(
        TextAttributes.BOLD | TextAttributes.ITALIC,
      )
      expect((chunks.find((chunk) => chunk.text === "old")?.attributes ?? 0) & TextAttributes.STRIKETHROUGH).toBe(
        TextAttributes.STRIKETHROUGH,
      )
      const cells = Array.from({ length: 65 }, (_, y) =>
        Array.from({ length: width }, (_, x) => ({ x, y, url: linkAt(rendered.renderer, x, y) })),
      ).flat()
      const links = [
        ...new Set(
          cells
            .map((cell) => cell.url)
            .filter((url) => url !== undefined)
            .filter((url) => url !== item.url),
        ),
      ]
      expect(links.sort()).toEqual(
        [
          "https://github.com/owner/repo/issues/43",
          "https://github.com/other/project/issues/12",
          "https://github.com/owner/repo/issues/44",
          "https://github.com/owner/repo/issues/45",
          "https://github.com/other/project/pull/46",
          "https://github.com/owner/repo/issues/47",
        ].sort(),
      )
      for (const url of links) {
        const cell = cells.find((cell) => cell.url === url)
        if (!cell) throw new Error("Missing reference cell")
        await rendered.mockMouse.click(cell.x, cell.y)
      }
      expect(opened.sort()).toEqual(links.sort())
      app.choices.push("#45")
      await app.key("r")
      expect(app.menus.at(-1)?.sort()).toEqual(
        ["#43", "other/project#12", "#44", "#45", "other/project#46", "#47"].sort(),
      )
      await Bun.write(`captures/markdown-${width}.txt`, frame)
    } finally {
      stop()
      rendered.renderer.destroy()
    }
  })
}

test("clicking a discussion reference and the keyboard picker preserve the Back path", async () => {
  const item = {
    ...issue,
    body: Array.from({ length: 30 }, (_, index) => `Paragraph ${index}.`).join("\n\n"),
    comments: [{ id: "1", author: "reviewer", body: "Related: #43" }],
  }
  const [feed, setFeed] = createSignal<Feed>({
    ...searchFeed([item]),
    selected: item.url,
  })
  const app = fixture(feed())
  const opened: string[] = []
  const open = async (url: string) => {
    opened.push(url)
    // GitHub resolves an issue-number reference to its canonical PR identity.
    setFeed({
      ...feed(),
      detail: pr,
      selected: pr.url,
      revision: feed().revision + 1,
      navigation: feed().navigation + 1,
    })
  }
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed()}
        focused
        width={70}
        close={() => {}}
        openURL={open}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 24 },
  )
  const stop = registerLinks(rendered.renderer, (url) => void open(url))
  try {
    await rendered.waitForFrame((frame) => frame.includes("Paragraph 0"))
    await rendered.waitForVisualIdle()
    await app.key("end")
    await rendered.waitForFrame((frame) => frame.includes("Related: #43"))
    const discussion = rendered.captureCharFrame()
    const cell = Array.from({ length: 24 }, (_, y) => Array.from({ length: 70 }, (_, x) => ({ x, y })))
      .flat()
      .find(({ x, y }) => linkAt(rendered.renderer, x, y) === "https://github.com/owner/repo/issues/43")
    if (!cell) throw new Error("Missing discussion reference")
    await rendered.mockMouse.click(cell.x, cell.y)
    await rendered.waitForFrame((frame) => frame.includes("Improve the reader"))
    expect(opened).toEqual(["https://github.com/owner/repo/issues/43"])
    await app.key("escape")
    await rendered.waitForFrame((frame) => frame.includes("Related: #43"))
    expect(rendered.captureCharFrame()).toBe(discussion)
    app.choices.push("#43")
    await app.key("r")
    await rendered.waitForFrame((frame) => frame.includes("Improve the reader"))
    expect(opened).toHaveLength(2)
    await app.key("escape")
    await rendered.waitForFrame((frame) => frame.includes("Related: #43"))
    await app.key("escape")
    await rendered.waitForFrame((frame) => !frame.includes("Back to results"))
  } finally {
    stop()
    rendered.renderer.destroy()
  }
})

test("an explicit chat link opens details from repository results", async () => {
  const initial = searchFeed([issue])
  const [state, setState] = createStore({ feed: initial })
  const opened: Feed = { ...initial, detail: issue, selected: issue.url, revision: 2, navigation: 2 }
  const app = fixture(initial)
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        sessionID="ses_link"
        feed={state.feed}
        focused
        width={80}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 80, height: 24 },
  )
  try {
    await rendered.waitForVisualIdle()
    setState(
      produce((draft) => {
        draft.feed = opened
      }),
    )
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain(issue.body)
    await app.key("escape")
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).not.toContain(issue.body)
    setState(
      produce((draft) => {
        draft.feed = { ...opened, revision: 3, navigation: 3 }
      }),
    )
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain(issue.body)
  } finally {
    rendered.renderer.destroy()
  }
})
function renderedImages(node: Renderable): ImageRenderable[] {
  return node
    .getChildren()
    .flatMap((child) =>
      child instanceof ImageRenderable ? [child] : child instanceof Renderable ? renderedImages(child) : [],
    )
}

for (const width of [32, 100]) {
  test(`descriptions and comments render native images within ${width} columns`, async () => {
    const item = {
      ...issue,
      body: 'Before screenshot\n\n<img width="1292" height="822" alt="Panel screenshot" src="https://github.com/user-attachments/assets/body" />\n\nAfter screenshot',
      comments: [
        {
          id: "1",
          author: "reviewer",
          body: "| Screenshot |\n| --- |\n| ![Comment screenshot](https://github.com/user-attachments/assets/comment) |",
        },
      ],
    }
    const feed = detailFeed(item)
    const requests: Request[] = []
    const app = fixture(feed, async (request) => {
      requests.push(request)
      return Response.json({ output: { data: imageData } })
    })
    const rendered = await testRender(
      () => (
        <Browser
          context={app.context}
          feed={feed}
          focused
          width={width}
          close={() => {}}
          openURL={async () => {}}
          openTab={async () => {}}
        />
      ),
      { width, height: 56 },
    )
    try {
      await rendered.waitFor(() => renderedImages(rendered.renderer.root).filter((image) => image.image).length === 2)
      await rendered.waitForVisualIdle()
      expect(requests).toHaveLength(2)
      const images = renderedImages(rendered.renderer.root)
      for (const image of images) {
        expect(image.image?.width).toBe(32)
        expect(image.image?.height).toBe(16)
        expect(image.x + image.width).toBeLessThanOrEqual(width)
        expect(image.height).toBeLessThanOrEqual(12)
      }
      const frame = await rendered.waitForFrame(
        (frame) => frame.includes("Before screenshot") && frame.includes("After screenshot"),
      )
      expect(frame).toContain("Before screenshot")
      expect(frame).toContain("After screenshot")
      expect(frame).toContain("Panel screenshot")
      expect(frame).toContain("Comment screenshot")
      expect(frame).not.toContain("<img")
      expect(frame).not.toContain("Loading image")
      const first = images[0]
      await rendered.mockMouse.click(first.x + 1, first.y + 1)
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("collapse")
      await Bun.write(`captures/images-${width}.txt`, rendered.captureCharFrame())
    } finally {
      rendered.renderer.destroy()
    }
    expect(requests.every((request) => request.signal.aborted)).toBe(true)
  })
}

test("image failure leaves readable text, retries on click, and Back cancels a pending image", async () => {
  const item = { ...issue, body: "Description text\n\n![Attachment](https://github.com/user-attachments/assets/test)" }
  const feed = searchFeed([item])
  const requests: Request[] = []
  const app = fixture(feed, async (request) => {
    requests.push(request)
    if (requests.length === 1) throw new Error("Image network unavailable")
    return new Promise<Response>((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }),
    )
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        focused
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 30 },
  )
  try {
    await app.key("enter")
    await rendered.waitForFrame((frame) => frame.includes("Click to retry") && frame.includes("Description text"))
    expect(rendered.captureCharFrame()).toContain("Description text")
    const lines = rendered.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("Click to retry"))
    await rendered.mockMouse.click(8, y)
    await rendered.waitFor(() => requests.length === 2)
    await app.key("escape")
    await rendered.renderOnce()
    expect(requests[1].signal.aborted).toBe(true)
    expect(rendered.captureCharFrame()).toContain("Keep GitHub inside")
  } finally {
    rendered.renderer.destroy()
  }
})

for (const width of [45, 110]) {
  test(`reader navigation and empty filters at ${width} columns`, async () => {
    const feed = searchFeed([{ ...issue, kind: "pr", url: issue.url.replace("/issues/", "/pull/") }, pr])
    const app = fixture(feed)
    const rendered = await testRender(
      () => (
        <Browser
          context={app.context}
          feed={feed}
          focused
          width={width}
          close={() => {}}
          openURL={async () => {}}
          openTab={async () => {}}
        />
      ),
      { width, height: 34 },
    )
    try {
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("Keep GitHub inside")
      await app.key("enter")
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("No discussion comments yet")
      await app.key("escape")
      app.prompts.push("nothing matches")
      await app.key("s")
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("No displayed results")
      expect(rendered.captureCharFrame()).toContain("x clear")
      await app.key("x")
      await app.key("down")
      await app.key("enter")
      await app.key("v")
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("src/reader.ts")
      await rendered.waitForVisualIdle()
      await Bun.write(`captures/reader-${width}.txt`, rendered.captureCharFrame())
    } finally {
      rendered.renderer.destroy()
    }
  })
}

test("inactive reader does not consume navigation keys", async () => {
  const feed = searchFeed([issue])
  const app = fixture(feed)
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        focused={false}
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 28 },
  )
  try {
    await app.key("enter")
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Inactive")
    expect(rendered.captureCharFrame()).not.toContain("No discussion comments yet")
  } finally {
    rendered.renderer.destroy()
  }
})

test("failed diff loads retry from details; pending reads cancel on Escape", async () => {
  const feed = detailFeed({ ...pr, files: null })
  const requests: Request[] = []
  const app = fixture(feed, async (request) => {
    requests.push(request)
    if (requests.length === 1)
      return Response.json({ type: "unavailable", message: "Offline", data: {} }, { status: 500 })
    return new Promise((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    )
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        sessionID="ses_test"
        focused
        width={80}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 80, height: 34 },
  )
  try {
    await rendered.renderOnce()
    // The PR already carries its description, so opening it must not issue a redundant details read.
    expect(requests).toHaveLength(0)
    expect(rendered.captureCharFrame()).not.toContain("Loading")
    await app.key("v")
    await rendered.renderOnce()
    expect(requests).toHaveLength(1)
    expect(rendered.captureCharFrame()).toContain("r retry")
    expect(rendered.captureCharFrame()).toContain("Load diff")
    const loading = app.key("r")
    await rendered.waitFor(() => requests.length === 2)
    await app.key("escape")
    await loading
    expect(requests[1].signal.aborted).toBe(true)
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).not.toContain("Loading")
  } finally {
    rendered.renderer.destroy()
  }
})

test("opening a bare reference loads its details once and renders the description", async () => {
  const bare = reference(issue.url)
  const feed = detailFeed(bare)
  const requests: Request[] = []
  const app = fixture(feed, async (request) => {
    requests.push(request)
    return Response.json({
      output: { part: "details", item: issue },
    })
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        sessionID="ses_test"
        focused
        width={80}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 80, height: 30 },
  )
  try {
    await rendered.waitFor(() => requests.length === 1)
    expect(await requests[0].clone().json()).toMatchObject({ input: { url: issue.url, part: "details" } })
    await rendered.waitForFrame((frame) => frame.includes(issue.body))
    await rendered.waitForVisualIdle()
    expect(rendered.captureCharFrame()).not.toContain("Loading")
    expect(requests).toHaveLength(1)
  } finally {
    rendered.renderer.destroy()
  }
})

test("a details read cancelled by moving on runs again when the item is reopened", async () => {
  const first = reference("https://github.com/owner/repo/issues/1")
  const second = reference("https://github.com/owner/repo/issues/2")
  const feed: Feed = { ...searchFeed([first, second]), selected: first.url }
  const requests: Request[] = []
  const app = fixture(feed, async (request) => {
    requests.push(request)
    const { input } = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.Struct({ url: Schema.String }) }))(
      await request.clone().json(),
    )
    if (requests.length === 1)
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      )
    const item = feed.items.find((item) => item.url === input.url)
    if (!item) throw new Error("Missing fixture item")
    return Response.json({
      output: {
        part: "details",
        item: { ...item, body: `Body of #${item.number}`, bodyLoaded: true },
      },
    })
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        sessionID="ses_test"
        focused
        width={80}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 80, height: 30 },
  )
  try {
    await rendered.waitFor(() => requests.length === 1)
    await app.key("n")
    expect(requests[0].signal.aborted).toBe(true)
    await rendered.waitForFrame((frame) => frame.includes("Body of #2"))
    await app.key("p")
    await rendered.waitForFrame((frame) => frame.includes("Body of #1"))
    expect(requests).toHaveLength(3)
    expect(rendered.captureCharFrame()).not.toContain("Load full details")
  } finally {
    rendered.renderer.destroy()
  }
})

test("Escape leaves a cancelled bare reference idle until it is explicitly retried", async () => {
  const item = reference(issue.url)
  const feed = detailFeed(item)
  const requests: Request[] = []
  const app = fixture(feed, async (request) => {
    requests.push(request)
    if (requests.length > 1) return Response.json({ output: { part: "details", item: issue } })
    return new Promise((_resolve, reject) =>
      request.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }),
    )
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        sessionID="ses_cancel"
        focused
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 25 },
  )
  try {
    await rendered.waitFor(() => requests.length === 1)
    await app.key("escape")
    await rendered.waitForVisualIdle()
    expect(requests[0].signal.aborted).toBe(true)
    expect(requests).toHaveLength(1)
    expect(rendered.captureCharFrame()).not.toContain("esc cancel")
    await app.key("l")
    await rendered.waitForFrame((frame) => frame.includes(issue.body))
    expect(requests).toHaveLength(2)
  } finally {
    rendered.renderer.destroy()
  }
})

test("query cache refreshes cannot save a view or change the current selection", async () => {
  const cache = createQueryClient()
  const feed: Feed = { ...searchFeed([issue]), selected: issue.url }
  const app = fixture(feed, async () => Response.json({ output: { part: "details", item: pr } }))
  const queries = browserQueries(cache, app.context.client)
  const rendered = await testRender(
    () => (
      <Browser
        queryClient={cache}
        context={app.context}
        feed={feed}
        sessionID="ses_selected"
        focused
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 25 },
  )
  try {
    await rendered.waitForFrame((frame) => frame.includes(issue.body))
    await queries.read({ directory: "/fixture" }, pr.url, "details", true, new AbortController().signal)
    await rendered.waitForVisualIdle()
    expect(cache.getQueryCache().getAll()).toHaveLength(1)
    expect(app.values.size).toBe(0)
    expect(rendered.captureCharFrame()).toContain(issue.body)
    expect(rendered.captureCharFrame()).not.toContain(pr.title)
    await app.key("escape")
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).not.toContain("Back to results")
  } finally {
    rendered.renderer.destroy()
    cache.clear()
  }
})

for (const width of [45, 110]) {
  test(`ten long issues fit in a compact ${width}-column pane`, async () => {
    const feed = searchFeed(
      Array.from({ length: 10 }, (_, index) => ({
        ...issue,
        number: 100 + index,
        url: `https://github.com/owner/repo/issues/${100 + index}`,
        title: `Result ${index + 1}: A long title that should never wrap and consume the entire panel`,
        labels: ["bug", "tui", "2.0"],
      })),
    )
    const app = fixture(feed)
    const rendered = await testRender(
      () => (
        <Browser
          context={app.context}
          feed={feed}
          focused
          width={width}
          close={() => {}}
          openURL={async () => {}}
          openTab={async () => {}}
        />
      ),
      { width, height: 28 },
    )
    try {
      await rendered.renderOnce()
      await rendered.waitForVisualIdle()
      const frame = rendered.captureCharFrame()
      for (const item of feed.items) expect(frame).toContain(`#${item.number}  Result`)
      expect(frame.match(/owner\/repo/g)).toHaveLength(1)
      expect(frame).toContain("10 of 10")
      expect(frame).toContain("? actions")
      await Bun.write(`captures/list-${width}.txt`, frame)
      await app.key("enter")
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain(issue.body)
    } finally {
      rendered.renderer.destroy()
    }
  })
}

test("a split panel paints the host's elevated surface; fullscreen keeps the base tokens", async () => {
  const feed = searchFeed([issue])
  const app = fixture(feed)
  const [presentation, setPresentation] = createSignal<"panel" | "fullscreen">("panel")
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        focused
        presentation={presentation()}
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 24 },
  )
  const surface = () => {
    const [root] = rendered.renderer.root.getChildren()
    return root instanceof BoxRenderable ? root.backgroundColor : undefined
  }
  try {
    await rendered.renderOnce()
    const theme = app.context.theme
    expect(theme.contextual.elevated.background.default).not.toEqual(theme.background.default)
    expect(surface()).toEqual(theme.contextual.elevated.background.default)
    expect(rendered.captureCharFrame()).not.toContain("┃")
    setPresentation("fullscreen")
    await rendered.renderOnce()
    expect(surface()).toEqual(theme.background.default)
  } finally {
    rendered.renderer.destroy()
  }
})

test("the compact actions menu runs available actions and hides detail-only actions in the list", async () => {
  const feed = searchFeed([pr])
  const app = fixture(feed)
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        focused
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 28 },
  )
  try {
    app.choices.push("Open item in panel")
    await app.key("?")
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Back to results")
    app.choices.push("View PR diff")
    await app.key("?")
    await rendered.renderOnce()
    expect(app.menus[1]).toContain("Open conversation about this item")
    expect([...new Set(app.menuGroups[1])]).toEqual(["Browse", "Item", "View"])
    expect(rendered.captureCharFrame()).toContain("src/reader.ts")
    await rendered.waitForVisualIdle()
  } finally {
    rendered.renderer.destroy()
  }
})

test("t opens a conversation with the selected item and location", async () => {
  const feed = searchFeed([issue])
  const opened: unknown[] = []
  const requests: Request[] = []
  const app = fixture(feed, async (request) => {
    requests.push(request)
    return Response.json({ output: feed })
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        sessionID="ses_test"
        focused
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async (item, location) => {
          opened.push({ item, location })
        }}
      />
    ),
    { width: 70, height: 28 },
  )
  try {
    await app.key("enter")
    await app.key("t")
    expect(opened).toEqual([{ item: issue, location: { directory: "/fixture" } }])
    expect(requests).toHaveLength(0)
  } finally {
    rendered.renderer.destroy()
  }
})

test("a fresh panel loads current-repository issues and switches PRs through server search", async () => {
  const feed = searchFeed([issue])
  const requests: { method: string; input: unknown }[] = []
  const requested = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.Struct({ kind: Kind }) }))
  const app = fixture(feed, async (request) => {
    const method = new URL(request.url).pathname.split("/").at(-1) ?? ""
    const input: unknown = await request.json()
    requests.push({ method, input })
    if (method === "current") return Response.json({ output: null })
    // Echo the requested kind the way the server does, so the active tab tracks it.
    const kind = requested(input).input.kind
    return Response.json({ output: { ...feed.search, items: kind === "pr" ? [pr] : [issue], kind } })
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        sessionID="ses_new"
        focused
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 28 },
  )
  try {
    await rendered.waitForVisualIdle()
    expect(requests.map((request) => request.method)).toEqual(["current", "search"])
    const frame = rendered.captureCharFrame()
    expect(frame).toContain(" Issues ")
    expect(frame).toContain("1 of 1")
    expect(requests[1].input).toMatchObject({
      input: { query: "is:open", kind: "issue", page: 1 },
    })
    await app.key("tab")
    expect(requests[2].input).toMatchObject({ input: { query: "is:open", kind: "pr" } })
    app.prompts.push("label:bug")
    await app.key("/")
    expect(requests[3].input).toMatchObject({ input: { query: "label:bug", kind: "pr" } })
    await app.key("i")
    expect(requests).toHaveLength(4) // Returning to a fresh query uses its cached result.
  } finally {
    rendered.renderer.destroy()
  }
})

test("repository browsing preserves pagination across tab switches", async () => {
  const feed = searchFeed(
    Array.from({ length: 10 }, (_, index) => ({
      ...issue,
      number: index + 1,
      url: `https://github.com/owner/repo/issues/${index + 1}`,
    })),
    { total: 342 },
  )
  const requests: { kind: string; page: number; query: string }[] = []
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({ input: Schema.Struct({ kind: Kind, page: Schema.Number, query: Schema.String }) }),
  )
  const app = fixture(feed, async (request) => {
    const { input } = decode(await request.json())
    requests.push(input)
    const items =
      input.kind === "pr"
        ? [pr]
        : Array.from({ length: 50 }, (_, row) => {
            const index = (input.page - 1) * 50 + row
            return {
              ...issue,
              number: 100 + index,
              url: `https://github.com/owner/repo/issues/${100 + index}`,
              title: `Repository issue ${100 + index}`,
            }
          })
    return Response.json({
      output: {
        items,
        ...input,
        query: "repo:owner/repo is:open",
        total: input.kind === "pr" ? 1 : 342,
        incomplete: false,
      },
    })
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        sessionID="ses_results"
        focused
        width={70}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 70, height: 28 },
  )
  try {
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("10 of 342")
    await app.key("i")
    await rendered.renderOnce()
    expect(requests[0]).toEqual({ kind: "issue", page: 1, query: "is:open" })
    expect(rendered.captureCharFrame()).toContain("50 of 342")
    await app.key("m")
    await rendered.renderOnce()
    expect(requests[1]).toEqual({ kind: "issue", page: 2, query: "is:open" })
    expect(rendered.captureCharFrame()).toContain("100 of 342")
    await app.key("tab")
    await rendered.renderOnce()
    expect(requests[2]).toEqual({ kind: "pr", page: 1, query: "is:open" })
    expect(rendered.captureCharFrame()).toContain("Improve the reader")
    await app.key("tab")
    await rendered.renderOnce()
    expect(requests).toHaveLength(3)
    expect(rendered.captureCharFrame()).toContain("100 of 342")
    expect(rendered.captureCharFrame()).toContain("Repository issue 100")
    expect(requests).toHaveLength(3)
  } finally {
    rendered.renderer.destroy()
  }
})

test("rendering an agent's chat link never populates either cache; clicking it explicitly loads the item", async () => {
  const queryClient = createQueryClient()
  const initial = searchFeed([issue], { query: "repo:owner/repo label:bug", text: "label:bug" })
  const [feed, setFeed] = createSignal(initial)
  const paths: string[] = []
  const app = fixture(initial, async (request) => {
    const path = new URL(request.url).pathname
    paths.push(path)
    expect(await request.json()).toMatchObject({ input: { url: pr.url, part: "details" } })
    return Response.json({ output: { part: "details", item: pr } })
  })
  const rendered = await testRender(
    () => (
      <box height="100%">
        <text flexShrink={0}>
          <a href={pr.url}>Agent mentioned #43</a>
        </text>
        <Browser
          context={app.context}
          sessionID="ses_saved"
          queryClient={queryClient}
          feed={feed()}
          focused
          width={70}
          close={() => {}}
          openURL={async () => {}}
          openTab={async () => {}}
        />
      </box>
    ),
    { width: 70, height: 28 },
  )
  const stop = registerLinks(rendered.renderer, (url) => {
    void app.context.client
      .rpc(GitHub)
      .open({ sessionID: "ses_saved", url }, { location: { directory: "/fixture" } })
      .then(setFeed)
  })
  try {
    await rendered.waitForVisualIdle()
    expect(paths).toEqual([])
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    expect(app.values.size).toBe(0)
    expect(rendered.captureCharFrame()).toContain("Keep GitHub inside")
    expect(rendered.captureCharFrame()).not.toContain("Improve the reader")
    await rendered.mockMouse.click(3, 0)
    await rendered.waitForFrame((frame) => frame.includes("Improve the reader"))
    expect(paths).toEqual(["/api/rpc/github-browser/read"])
    const cached = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data)
    expect(cached).toHaveLength(1)
    expect(JSON.stringify(cached)).toContain(pr.url)
    expect(app.values.size).toBe(1)
    await app.key("escape")
    await rendered.waitForFrame((frame) => frame.includes("1 of 1"))
    expect(rendered.captureCharFrame()).toContain(issue.title)
    expect(rendered.captureCharFrame()).not.toContain(pr.title)
    expect(paths).toEqual(["/api/rpc/github-browser/read"])
    const saved = Schema.decodeUnknownSync(Schema.Struct({ feed: Feed }))(app.values.get("browser.v2/ses_saved"))
    expect(saved.feed.items.map((item) => item.url)).toEqual([issue.url])
    expect(saved.feed.search?.query).toBe("repo:owner/repo label:bug")
  } finally {
    stop()
    rendered.renderer.destroy()
    queryClient.clear()
  }
})

for (const width of [45, 110]) {
  test(`a chat link in a new session returns to the normal 50-issue page at ${width} columns`, async () => {
    const queryClient = createQueryClient()
    const links = Array.from({ length: 10 }, (_, index) => ({
      ...issue,
      number: 900 + index,
      url: `https://github.com/owner/repo/issues/${900 + index}`,
      title: `Agent-linked issue ${900 + index}`,
      body: `Details of linked issue ${900 + index}`,
    }))
    const rows = Array.from({ length: 50 }, (_, index) => ({
      ...issue,
      number: 100 + index,
      url: `https://github.com/owner/repo/issues/${100 + index}`,
      title: `Repository issue ${100 + index}`,
    }))
    const [feed, setFeed] = createSignal<Feed>()
    const searches: unknown[] = []
    const reads: string[] = []
    const app = fixture(emptyFeed, async (request) => {
      const method = new URL(request.url).pathname.split("/").at(-1)
      if (method === "read") {
        const { input } = Schema.decodeUnknownSync(Schema.Struct({ input: Schema.Struct({ url: Schema.String }) }))(
          await request.json(),
        )
        reads.push(input.url)
        const item = links.find((item) => item.url === input.url)
        if (!item) throw new Error("Unexpected detail read")
        return Response.json({ output: { part: "details", item } })
      }
      if (method !== "search") throw new Error(`Unexpected request: ${method}`)
      searches.push(await request.json())
      return Response.json({
        output: {
          items: rows,
          query: "repo:owner/repo is:open",
          kind: "issue",
          page: 1,
          total: 120,
          incomplete: false,
        },
      })
    })
    const open = async (url: string) => {
      setFeed(
        await app.context.client
          .rpc(GitHub)
          .open({ sessionID: "ses_new_chat", url }, { location: { directory: "/fixture" } }),
      )
    }
    const rendered = await testRender(
      () => (
        <box height="100%">
          <text flexShrink={0}>
            <For each={links}>{(item) => <a href={item.url}>#{item.number} </a>}</For>
          </text>
          <Show when={feed()}>
            <Browser
              context={app.context}
              feed={feed()}
              queryClient={queryClient}
              sessionID="ses_new_chat"
              focused
              width={width}
              close={() => {}}
              openURL={open}
              openTab={async () => {}}
            />
          </Show>
        </box>
      ),
      { width, height: 28 },
    )
    const stop = registerLinks(rendered.renderer, (url) => void open(url))
    const saved = () =>
      Schema.decodeUnknownSync(Schema.Struct({ feed: Feed }))(app.values.get("browser.v2/ses_new_chat")).feed
    try {
      await rendered.waitForVisualIdle()
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
      await rendered.mockMouse.click(2, 0)
      await rendered.waitForFrame((frame) => frame.includes("Details of linked issue 900"))
      expect(saved().items).toEqual([])
      expect(saved().detail?.url).toBe(links[0].url)
      expect(searches).toEqual([])
      // Follow another link and go Back through details before returning to results.
      await open(links[1].url)
      await rendered.waitForFrame((frame) => frame.includes("Details of linked issue 901"))
      await app.key("escape")
      await rendered.waitForFrame((frame) => frame.includes("Details of linked issue 900"))
      expect(reads).toEqual([links[0].url, links[1].url])
      await app.key("escape")
      await rendered.waitForFrame((frame) => frame.includes("50 of 120"))
      expect(searches).toEqual([{ input: { query: "is:open", kind: "issue", page: 1 } }])
      expect(saved().items.map((item) => item.url)).toEqual(rows.map((item) => item.url))
      expect(saved().detail).toBeUndefined()
      expect(rendered.captureCharFrame()).toContain("Repository issue 100")
      expect(rendered.captureCharFrame()).not.toContain("Agent-linked issue")
      const cached = queryClient
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey.includes("search"))
      expect(cached?.state.data).toMatchObject({ pages: [{ items: rows }], pageParams: [1] })
    } finally {
      stop()
      rendered.renderer.destroy()
      queryClient.clear()
    }
  })
}

for (const width of [32, 45, 80]) {
  test(`refresh keeps saved rows below a separate loader at ${width} columns`, async () => {
    const feed = searchFeed([
      { ...issue, title: "Long first title with enough words to wrap until THE END" },
      {
        ...issue,
        number: 43,
        url: "https://github.com/owner/repo/issues/43",
        title: "SECOND row with a very long title that must end with an ellipsis in the list",
      },
    ])
    const requests: unknown[] = []
    const app = fixture(feed, async (request) => {
      requests.push(await request.json())
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      )
    })
    const rendered = await testRender(
      () => (
        <Browser
          context={app.context}
          feed={feed}
          sessionID="ses_refresh"
          focused
          width={width}
          close={() => {}}
          openURL={async () => {}}
          openTab={async () => {}}
        />
      ),
      { width, height: 26 },
    )
    try {
      await rendered.waitForVisualIdle()
      const before = rendered.captureCharFrame().split("\n")
      expect(before.join("\n")).toContain("THE END")
      expect(before.some((line) => line.includes("SECOND") && line.includes("…"))).toBe(true)
      const pending = app.key("l")
      await rendered.renderOnce()
      const during = rendered.captureCharFrame().split("\n")
      const loader = during.findIndex((line) => line.includes("Refreshing"))
      expect(loader).toBeGreaterThanOrEqual(0)
      expect(during[loader]).toContain("esc cancel")
      expect(during[loader]).not.toContain("Long first")
      expect(during.findIndex((line) => line.includes("SECOND"))).toBe(
        before.findIndex((line) => line.includes("SECOND")),
      )
      expect(requests[0]).toMatchObject({ input: { refresh: true } })
      await Bun.write(`captures/loading-${width}.txt`, rendered.captureCharFrame())
      await app.key("escape")
      await pending
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).not.toContain("Refreshing")
      expect(rendered.captureCharFrame()).toContain("SECOND")
    } finally {
      rendered.renderer.destroy()
    }
  })
}

test("an empty pending search shows placeholders instead of the empty-state instructions", async () => {
  const feed = emptyFeed
  const app = fixture(
    feed,
    async (request) =>
      new Promise((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      ),
  )
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        sessionID="ses_empty"
        focused
        width={45}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 45, height: 20 },
  )
  try {
    const pending = app.key("i")
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).toContain("Loading issues")
    expect(rendered.captureCharFrame()).not.toContain("Search GitHub or open")
    await app.key("escape")
    await pending
    await rendered.renderOnce()
    expect(rendered.captureCharFrame()).not.toContain("Loading issues")
  } finally {
    rendered.renderer.destroy()
  }
})

test("first open stays in loading from saved-view lookup through the initial search", async () => {
  const feed = searchFeed([issue])
  const current = Promise.withResolvers<Response>()
  const search = Promise.withResolvers<Response>()
  const searching = Promise.withResolvers<void>()
  const app = fixture(feed, async (request) => {
    if (new URL(request.url).pathname.endsWith("/current")) return current.promise
    searching.resolve()
    return search.promise
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        sessionID="ses_first"
        focused
        width={60}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 60, height: 24 },
  )
  try {
    await rendered.renderOnce()
    const first = rendered.captureCharFrame()
    expect(first).toContain("Opening GitHub")
    expect(first).not.toContain("Search GitHub or open")
    current.resolve(Response.json({ output: null }))
    await searching.promise
    await rendered.renderOnce()
    const second = rendered.captureCharFrame()
    expect(second).toContain("Loading issues")
    expect(second.split("\n").findIndex((line) => line.includes("esc cancel"))).toBe(
      first.split("\n").findIndex((line) => line.includes("esc cancel")),
    )
    search.resolve(Response.json({ output: { ...feed.search, items: feed.items } }))
    await rendered.waitForVisualIdle()
    expect(rendered.captureCharFrame()).toContain("Keep GitHub inside")
    expect(rendered.captureCharFrame()).not.toContain("esc cancel")
    await Bun.write("captures/first-open.txt", second)
  } finally {
    rendered.renderer.destroy()
  }
})

test("Escape cancels the saved-view lookup and ignores its late reply", async () => {
  const current = Promise.withResolvers<Response>()
  const requests: Request[] = []
  const feed = searchFeed([issue])
  const app = fixture(feed, async (request) => {
    requests.push(request)
    return current.promise
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        sessionID="ses_cancel_open"
        focused
        width={45}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 45, height: 20 },
  )
  try {
    await rendered.renderOnce()
    await app.key("escape")
    expect(requests[0].signal.aborted).toBe(true)
    current.resolve(Response.json({ output: null }))
    await rendered.waitForVisualIdle()
    expect(requests).toHaveLength(1)
    expect(rendered.captureCharFrame()).not.toContain("esc cancel")
  } finally {
    rendered.renderer.destroy()
  }
})

test("a failed first-open lookup stops loading and Retry restores the saved view", async () => {
  const feed = searchFeed([pr])
  let count = 0
  const app = fixture(feed, async () =>
    ++count === 1
      ? Response.json({ type: "unavailable", message: "Offline", data: {} }, { status: 500 })
      : Response.json({ output: feed }),
  )
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        sessionID="ses_retry_open"
        focused
        width={45}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 45, height: 20 },
  )
  try {
    await rendered.waitForVisualIdle()
    expect(rendered.captureCharFrame()).toContain("Offline")
    expect(rendered.captureCharFrame()).toContain("r retry")
    expect(rendered.captureCharFrame()).not.toContain("esc cancel")
    await app.key("r")
    await rendered.waitForVisualIdle()
    expect(rendered.captureCharFrame()).toContain("Improve the reader")
    expect(count).toBe(2)
  } finally {
    rendered.renderer.destroy()
  }
})

test("closing during first-open session creation cannot start a search afterwards", async () => {
  const creating = Promise.withResolvers<Response>()
  const paths: string[] = []
  const app = fixture(emptyFeed, async (request) => {
    paths.push(new URL(request.url).pathname)
    return creating.promise
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        focused
        width={45}
        close={() => {}}
        openURL={async () => {}}
        openTab={async () => {}}
      />
    ),
    { width: 45, height: 20 },
  )
  await rendered.renderOnce()
  expect(rendered.captureCharFrame()).toContain("Loading issues")
  rendered.renderer.destroy()
  creating.resolve(Response.json({ id: "ses_created" }))
  // Flush the response continuation without a wall-clock delay.
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(paths).toHaveLength(1)
})
