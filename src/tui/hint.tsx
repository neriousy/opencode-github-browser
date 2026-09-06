import type { MouseEvent } from "@opentui/core"
import type { ThemeTokens } from "./context"

/** A keyboard hint in the host's footer style: the key in default text, its label subdued. */
export function Hint(props: {
  theme: ThemeTokens
  keys: string
  label?: string
  onMouseUp?: (event: MouseEvent) => void
  flexShrink?: number
}) {
  return (
    <text
      fg={props.theme.text.default}
      wrapMode="none"
      flexShrink={props.flexShrink ?? 0}
      onMouseUp={props.onMouseUp}
      selectable={false}
    >
      {props.keys}
      {props.label ? <span style={{ fg: props.theme.text.subdued }}> {props.label}</span> : ""}
    </text>
  )
}
