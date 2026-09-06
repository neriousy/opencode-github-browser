import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import { DEFAULT_THEME, resolveThemeDocument } from "@opencode-ai/theme/tui"
import type { KeymapLayer } from "@opencode-ai/plugin/tui/context"
import { testRender } from "@opentui/solid"
import { BoxRenderable, ImageRenderable, Renderable, TextRenderable, TextAttributes } from "@opentui/core"
import { createSignal } from "solid-js"
import { Option, Schema } from "effect"
import { createStore, produce } from "solid-js/store"
import { Browser } from "../../src/tui/browser"
import type { BrowserHost } from "../../src/tui/context"
import { Kind, type Feed } from "../../src/shared/rpc"
import { reference } from "../../src/shared/url"
import { linkAt, registerLinks } from "../../src/tui/links"

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
  const client = OpenCode.make({
    baseUrl: "http://fixture.invalid",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => response(new Request(input, init)), {
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
          author: "reviewer",
          body: "> Duplicates:\n> - **#45** is related.\n> - <https://github.com/other/project/pull/46?email_token=fixture>\n\n[More context](https://github.com/owner/repo/issues/47) &amp; \\#901.\n\n[External #902](https://example.com)\n\n```ts\nconst example = '#903'\n```",
        },
      ],
    }
    const feed = { items: [item], selected: item.url, note: "", revision: 1, navigation: 1 }
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
    comments: [{ author: "reviewer", body: "Related: #43" }],
  }
  const [feed, setFeed] = createSignal<Feed>({
    items: [item],
    selected: item.url,
    note: "",
    revision: 1,
    navigation: 1,
  })
  const app = fixture(feed())
  const opened: string[] = []
  const open = async (url: string) => {
    opened.push(url)
    // GitHub resolves an issue-number reference to its canonical PR identity.
    setFeed({
      ...feed(),
      items: [item, pr],
      selected: pr.url,
      revision: (feed().revision ?? 0) + 1,
      navigation: (feed().navigation ?? 0) + 1,
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

for (const origin of ["repository", "legacy MCP"]) {
  test(`an explicit chat link opens details from a ${origin} response`, async () => {
    const initial: Feed = {
      items: [issue],
      selected: null,
      note: "GitHub search · repo:owner/repo is:open",
      revision: 1,
      navigation: 1,
      search: { query: "repo:owner/repo is:open", kind: "issue", page: 1, total: 1, incomplete: false },
    }
    const [state, setState] = createStore({ feed: initial })
    const opened: Feed =
      origin === "repository"
        ? { ...initial, selected: issue.url, note: "GitHub", revision: 2, navigation: 2 }
        : { items: [issue], selected: issue.url, note: "GitHub MCP", revision: 2, navigation: 2 }
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
}
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
          author: "reviewer",
          body: "| Screenshot |\n| --- |\n| ![Comment screenshot](https://github.com/user-attachments/assets/comment) |",
        },
      ],
    }
    const feed = { items: [item], selected: item.url, note: "", navigation: 1, revision: 1 }
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
  const feed = { items: [item], selected: null, note: "" }
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
    const feed = { items: [issue, pr], selected: null, note: "GitHub" }
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
  const feed = { items: [issue], selected: null, note: "" }
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
  const feed: Feed = { revision: 1, items: [{ ...pr, files: null }], selected: pr.url, note: "" }
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
  const feed: Feed = { revision: 1, items: [bare], selected: bare.url, note: "" }
  const requests: Request[] = []
  const app = fixture(feed, async (request) => {
    requests.push(request)
    return Response.json({
      output: { ...feed, revision: 2, items: [{ ...issue, bodyLoaded: true }], selected: issue.url },
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
  const feed: Feed = { revision: 1, items: [first, second], selected: first.url, note: "" }
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
    return Response.json({
      output: {
        ...feed,
        revision: requests.length + 1,
        items: feed.items.map((row) =>
          row === item ? { ...row, body: `Body of #${row.number}`, bodyLoaded: true } : row,
        ),
        selected: input.url,
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

for (const width of [45, 110]) {
  test(`ten long issues fit in a compact ${width}-column pane`, async () => {
    const feed = {
      items: Array.from({ length: 10 }, (_, index) => ({
        ...issue,
        number: 100 + index,
        url: `https://github.com/owner/repo/issues/${100 + index}`,
        title: `Result ${index + 1}: A long title that should never wrap and consume the entire panel`,
        labels: ["bug", "tui", "2.0"],
        reason: "A duplicate summary that belongs in the detail view.",
      })),
      selected: null,
      note: "Ten recently updated issues with a very long explanation that used to consume the header.",
    }
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
      expect(frame).not.toContain(" Shortlist ")
      expect(frame).not.toContain(" All ")
      expect(frame).not.toContain("GitHub · selection")
      expect(frame).toContain("10 selected")
      expect(frame).not.toContain("duplicate summary")
      expect(frame).not.toContain("recently updated")
      expect(frame).toContain("? actions")
      await Bun.write(`captures/list-${width}.txt`, frame)
      await app.key("enter")
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("A duplicate summary")
    } finally {
      rendered.renderer.destroy()
    }
  })
}

test("a split panel paints the host's elevated surface; fullscreen keeps the base tokens", async () => {
  const feed = { items: [issue], selected: null, note: "" }
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
  const feed = { items: [pr], selected: null, note: "" }
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
    expect(app.menus[0]).not.toContain("Ask agent")
    expect(rendered.captureCharFrame()).toContain("Back to results")
    app.choices.push("View PR diff")
    await app.key("?")
    await rendered.renderOnce()
    expect(app.menus[1]).not.toContain("Ask agent")
    expect(app.menus[1]).toContain("Open conversation about this item")
    expect(app.menus[1]).not.toContain("Discuss item")
    expect(app.menus[1]).not.toContain("Work on / review item")
    expect([...new Set(app.menuGroups[1])]).toEqual(["Browse", "Item", "View"])
    expect(rendered.captureCharFrame()).toContain("src/reader.ts")
    await rendered.waitForVisualIdle()
  } finally {
    rendered.renderer.destroy()
  }
})

test("t opens a conversation with the item; a no longer opens a separate request dialog", async () => {
  const feed = { items: [issue], selected: null, note: "" }
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
    await app.key("a")
    expect(app.menus).toEqual([])
    expect(opened).toEqual([])
    await app.key("t")
    expect(opened).toEqual([{ item: issue, location: { directory: "/fixture" } }])
    expect(requests).toHaveLength(0)
  } finally {
    rendered.renderer.destroy()
  }
})

test("a fresh panel loads current-repository issues and switches PRs through server search", async () => {
  const feed: Feed = {
    items: [issue],
    selected: null,
    note: "",
    search: { query: "repo:owner/repo is:open", text: "is:open", kind: "issue", page: 1, total: 1, incomplete: false },
  }
  const requests: { method: string; input: unknown }[] = []
  const requested = Schema.decodeUnknownOption(Schema.Struct({ input: Schema.Struct({ kind: Kind }) }))
  const app = fixture(feed, async (request) => {
    const method = new URL(request.url).pathname.split("/").at(-1) ?? ""
    const input: unknown = await request.json()
    requests.push({ method, input })
    if (method === "current") return Response.json({ output: null })
    // Echo the requested kind the way the server does, so the active tab tracks it.
    const kind = Option.getOrUndefined(requested(input))?.input.kind ?? "issue"
    return Response.json({ output: { ...feed, search: { ...feed.search, kind } } })
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
    expect(frame).not.toContain(" All ")
    expect(frame).toContain("1 of 1")
    expect(requests[1].input).toMatchObject({
      input: { sessionID: "ses_new", query: "is:open", kind: "issue", page: 1 },
    })
    await app.key("tab")
    expect(requests[2].input).toMatchObject({ input: { query: "is:open", kind: "pr" } })
    app.prompts.push("label:bug")
    await app.key("/")
    expect(requests[3].input).toMatchObject({ input: { query: "label:bug", kind: "pr" } })
    await app.key("i")
    expect(requests[4].input).toMatchObject({ input: { query: "is:open", kind: "issue" } })
  } finally {
    rendered.renderer.destroy()
  }
})

test("repository browsing preserves pagination and switches tabs without a chat selection action", async () => {
  const shortlist = {
    items: Array.from({ length: 10 }, (_, index) => ({
      ...issue,
      number: index + 1,
      url: `https://github.com/owner/repo/issues/${index + 1}`,
    })),
    note: "Agent recommendations",
  }
  const feed: Feed = {
    ...shortlist,
    selected: null,
    shortlist,
    revision: 1,
    navigation: 1,
    search: {
      query: "repo:owner/repo is:open",
      text: "is:open",
      kind: "issue",
      page: 1,
      total: 342,
      incomplete: false,
    },
  }
  const requests: { kind: string; page: number; query: string }[] = []
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({ input: Schema.Struct({ kind: Kind, page: Schema.Number, query: Schema.String }) }),
  )
  let revision = 1
  const app = fixture(feed, async (request) => {
    const { input } = decode(await request.json())
    requests.push(input)
    const items =
      input.kind === "pr"
        ? [pr]
        : Array.from({ length: input.page * 50 }, (_, index) => ({
            ...issue,
            number: 100 + index,
            url: `https://github.com/owner/repo/issues/${100 + index}`,
            title: `Repository issue ${100 + index}`,
          }))
    return Response.json({
      output: {
        items,
        selected: null,
        note: "Repository results",
        shortlist,
        revision: ++revision,
        navigation: revision,
        search: {
          ...input,
          text: "is:open",
          query: "repo:owner/repo is:open",
          total: input.kind === "pr" ? 1 : 342,
          incomplete: false,
        },
      },
    })
  })
  const rendered = await testRender(
    () => (
      <Browser
        context={app.context}
        feed={feed}
        sessionID="ses_shortlist"
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
    expect(requests[1]).toEqual({ kind: "issue", page: 2, query: "repo:owner/repo is:open" })
    expect(rendered.captureCharFrame()).toContain("100 of 342")
    await app.key("tab")
    await rendered.renderOnce()
    expect(requests[2]).toEqual({ kind: "pr", page: 1, query: "is:open" })
    expect(rendered.captureCharFrame()).toContain("Improve the reader")
    expect(rendered.captureCharFrame()).not.toContain("Shortlist")
    await app.key("tab")
    await rendered.renderOnce()
    expect(requests[3]).toEqual({ kind: "issue", page: 1, query: "is:open" })
    await app.key("?")
    await rendered.renderOnce()
    expect(app.menus.at(-1)).not.toContain("Restore selected results")
    expect(rendered.captureCharFrame()).toContain("50 of 342")
    expect(rendered.captureCharFrame()).toContain("Repository issue 100")
    expect(requests).toHaveLength(4)
    expect(rendered.captureCharFrame()).not.toContain("Shortlist")
  } finally {
    rendered.renderer.destroy()
  }
})

for (const source of ["memory", "disk"]) {
  test(`opening GitHub after a chat reference ignores the old ${source} MCP list`, async () => {
    const feed: Feed = {
      items: [pr],
      selected: source === "disk" ? pr.url : null,
      note: source === "disk" ? "GitHub MCP" : "MCP results · a mentioned PR",
      revision: 10,
    }
    const results: Feed = {
      items: [issue],
      selected: null,
      note: "Repository results",
      revision: 11,
      search: {
        query: "repo:owner/repo is:open",
        text: "is:open",
        kind: "issue",
        page: 1,
        total: 50,
        incomplete: false,
      },
    }
    const paths: string[] = []
    const app = fixture(feed, async (request) => {
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path.endsWith("/current")) return Response.json({ output: feed })
      expect(await request.json()).toMatchObject({ input: { query: "is:open", kind: "issue", page: 1 } })
      return Response.json({ output: results })
    })
    const rendered = await testRender(
      () => (
        <Browser
          context={app.context}
          sessionID="ses_saved"
          feed={source === "memory" ? feed : undefined}
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
      expect(paths).toEqual(["/api/rpc/github-browser/current", "/api/rpc/github-browser/search"])
      expect(rendered.captureCharFrame()).toContain("Keep GitHub inside")
      expect(rendered.captureCharFrame()).not.toContain("Improve the reader")
      expect(rendered.captureCharFrame()).toContain("1 of 50")
    } finally {
      rendered.renderer.destroy()
    }
  })
}

for (const width of [32, 45, 80]) {
  test(`refresh keeps saved rows below a separate loader at ${width} columns`, async () => {
    const feed: Feed = {
      items: [
        { ...issue, title: "Long first title with enough words to wrap until THE END" },
        { ...pr, title: "SECOND row with a very long title that must end with an ellipsis in the list" },
      ],
      selected: null,
      note: "",
      search: { query: "repo:owner/repo is:open", kind: "all", page: 1, total: 2, incomplete: false },
    }
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
  const feed: Feed = { items: [], selected: null, note: "" }
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
  const feed: Feed = {
    items: [issue],
    selected: null,
    note: "",
    search: { query: "repo:owner/repo is:open", text: "is:open", kind: "issue", page: 1, total: 1, incomplete: false },
  }
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
    expect(first).not.toContain(" All ")
    current.resolve(Response.json({ output: null }))
    await searching.promise
    await rendered.renderOnce()
    const second = rendered.captureCharFrame()
    expect(second).toContain("Loading issues")
    expect(second.split("\n").findIndex((line) => line.includes("esc cancel"))).toBe(
      first.split("\n").findIndex((line) => line.includes("esc cancel")),
    )
    search.resolve(Response.json({ output: feed }))
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
  const feed = { items: [issue], selected: null, note: "" }
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
  const feed = { items: [pr], selected: null, note: "Shortlist" }
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
  const app = fixture({ items: [], selected: null, note: "" }, async (request) => {
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
