import type { BrowserContext } from "./context"
import { SyntaxStyle, TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import type { DiffFile } from "../shared/rpc"

export function PullRequestDiff(props: {
  context: BrowserContext
  files: readonly DiffFile[]
  syntax: SyntaxStyle
  focused: boolean
  width: number
}) {
  const [index, setIndex] = createSignal(0)
  const [split, setSplit] = createSignal(false)
  const current = createMemo(() => Math.max(0, Math.min(index(), props.files.length - 1)))
  const file = createMemo(() => props.files[current()])
  let scroll: ScrollBoxRenderable | undefined
  const move = (offset: number) => {
    setIndex(Math.max(0, Math.min(props.files.length - 1, current() + offset)))
    scroll?.scrollTo(0)
  }
  const choose = async () => {
    const result = await props.context.ui.dialog.select({
      title: "Changed files",
      options: props.files.map((file, value) => ({
        title: file.filename,
        description: `+${file.additions} −${file.deletions} · ${file.status}`,
        value,
      })),
      current: current(),
    })
    if (result !== undefined) {
      setIndex(result)
      scroll?.scrollTo(0)
    }
  }
  props.context.keymap.layer(() => ({
    enabled: props.focused,
    commands: [
      {
        bind: "down,j",
        title: "Scroll diff down",
        run: () => {
          scroll?.scrollBy(1)
        },
      },
      {
        bind: "up,k",
        title: "Scroll diff up",
        run: () => {
          scroll?.scrollBy(-1)
        },
      },
      {
        bind: "pagedown",
        title: "Next diff page",
        run: () => {
          scroll?.scrollBy(Math.max(1, scroll.height * 0.8))
        },
      },
      {
        bind: "pageup",
        title: "Previous diff page",
        run: () => {
          scroll?.scrollBy(-Math.max(1, scroll.height * 0.8))
        },
      },
      {
        bind: "home",
        title: "Start of diff",
        run: () => {
          scroll?.scrollTo(0)
        },
      },
      {
        bind: "end",
        title: "End of diff",
        run: () => {
          scroll?.scrollTo(scroll.scrollHeight)
        },
      },
      {
        id: "github-browser.diff.files",
        title: "Choose changed file",
        bind: "c",
        run: choose,
      },
      {
        id: "github-browser.diff.next",
        title: "Next file",
        bind: "]",
        run: () => {
          move(1)
        },
      },
      {
        id: "github-browser.diff.previous",
        title: "Previous file",
        bind: "[",
        run: () => {
          move(-1)
        },
      },
      {
        id: "github-browser.diff.layout",
        title: "Toggle split diff",
        bind: "v",
        run: () => {
          setSplit((value) => !value)
        },
      },
    ],
  }))
  const theme = () => props.context.theme
  const patch = () => {
    const item = file()
    if (!item?.patch) return ""
    return [
      `diff --git a/${item.previous_filename ?? item.filename} b/${item.filename}`,
      `--- ${item.status === "added" ? "/dev/null" : `a/${item.previous_filename ?? item.filename}`}`,
      `+++ ${item.status === "removed" ? "/dev/null" : `b/${item.filename}`}`,
      item.patch,
      "",
    ].join("\n")
  }

  return (
    <box flexGrow={1} flexBasis={0} minHeight={0} minWidth={0} width="100%" gap={1}>
      <Show when={file()} fallback={<text fg={theme().text.subdued}>No changed files</text>}>
        {(item) => (
          <>
            <box flexDirection="row" justifyContent="space-between" gap={2} flexShrink={0}>
              <text
                fg={theme().text.default}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
                truncate
                flexShrink={1}
                minWidth={0}
                onMouseUp={() => void choose()}
              >
                {item().filename}
              </text>
              <text fg={theme().text.subdued} wrapMode="none" flexShrink={0}>
                {`${current() + 1}/${props.files.length}`}
              </text>
            </box>
            <text flexShrink={0} wrapMode="none" truncate>
              <span style={{ fg: theme().diff.text.added }}>{`+${item().additions}`}</span>
              <span style={{ fg: theme().text.subdued }}> </span>
              <span style={{ fg: theme().diff.text.removed }}>{`−${item().deletions}`}</span>
              <span style={{ fg: theme().text.subdued }}>
                {` · ${item().status} · ${split() && props.width >= 90 ? "split" : "unified"}`}
              </span>
            </text>
            <Show when={item().previous_filename}>
              <text flexShrink={0} fg={theme().text.subdued} wrapMode="word">
                Renamed from {item().previous_filename}
              </text>
            </Show>
            <scrollbox
              ref={(value) => {
                scroll = value
              }}
              flexGrow={1}
              flexBasis={0}
              minHeight={0}
              width="100%"
              scrollX={false}
              verticalScrollbarOptions={{
                position: "absolute",
                right: 0,
                top: 0,
                width: 1,
                height: "100%",
                trackOptions: {
                  backgroundColor: theme().background.default,
                  foregroundColor: theme().scrollbar.default,
                },
              }}
              contentOptions={{ paddingRight: 1 }}
            >
              <Show
                when={patch()}
                fallback={<text fg={theme().text.subdued}>Binary file or patch unavailable from GitHub.</text>}
              >
                <diff
                  diff={patch()}
                  width="100%"
                  view={split() && props.width >= 90 ? "split" : "unified"}
                  syntaxStyle={props.syntax}
                  showLineNumbers
                  wrapMode={split() && props.width >= 90 ? "none" : "char"}
                  fg={theme().text.default}
                  addedBg={theme().diff.background.added}
                  removedBg={theme().diff.background.removed}
                  contextBg={theme().diff.background.context}
                  addedSignColor={theme().diff.highlight.added}
                  removedSignColor={theme().diff.highlight.removed}
                  lineNumberFg={theme().diff.lineNumber.text}
                  lineNumberBg={theme().diff.background.context}
                  addedLineNumberBg={theme().diff.lineNumber.background.added}
                  removedLineNumberBg={theme().diff.lineNumber.background.removed}
                />
              </Show>
            </scrollbox>
          </>
        )}
      </Show>
    </box>
  )
}
