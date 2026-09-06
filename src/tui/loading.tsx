import { createSignal, onCleanup, onMount } from "solid-js"
import type { ThemeTokens } from "./context"
import { Hint } from "./hint"

/** The host's braille spinner frames and interval. */
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Mount only during a request; the parent reserves its row to prevent layout jumps. */
export function Loading(props: { theme: ThemeTokens; label: string; cancel: () => void }) {
  const [frame, setFrame] = createSignal(0)
  onMount(() => {
    const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 80)
    onCleanup(() => clearInterval(timer))
  })
  return (
    <box height={1} flexShrink={0} flexDirection="row" gap={1} width="100%" overflow="hidden">
      <text width={1} flexShrink={0} fg={props.theme.text.subdued}>
        {frames[frame()]}
      </text>
      <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate fg={props.theme.text.subdued}>
        {props.label}
      </text>
      <Hint theme={props.theme} keys="esc" label="cancel" onMouseUp={props.cancel} />
    </box>
  )
}
