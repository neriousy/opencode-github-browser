import { getLinkId, MouseButton, type CliRenderer, type MouseEvent } from "@opentui/core"
import { githubURL } from "../shared/url"

/** OpenTUI 0.5 exposes link IDs in cells but omits the URL lookup from RenderLib's type. */
export function linkAt(renderer: CliRenderer, x: number, y: number) {
  const buffer = renderer.currentRenderBuffer
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return
  const id = getLinkId(buffer.buffers.attributes[y * buffer.width + x])
  const lib = buffer.lib
  if (!id || !("linkGetUrl" in lib) || typeof lib.linkGetUrl !== "function") return
  const url = lib.linkGetUrl(id, 8192)
  return typeof url === "string" ? githubURL(url)?.url : undefined
}

/** Isolated compatibility adapter until OpenCode exposes a link-click registration API.
 * Observe bubbled mouse events without replacing the host's mouse handlers.
 */
export function registerLinks(renderer: CliRenderer, open: (url: string) => void) {
  const root = renderer.root
  const previous = root.processMouseEvent
  let active = true
  let pressed: string | undefined
  let dragged = false
  const handler = function (this: typeof root, event: MouseEvent) {
    previous.call(this, event)
    if (!active || event.defaultPrevented) return
    if (event.type === "drag" || event.type === "drag-end") dragged = true
    if (event.button !== MouseButton.LEFT) return
    if (event.type === "down") {
      dragged = false
      // Text and Markdown tables are selectable; pane-focus overlays are not.
      // Use the host capability rather than instanceof across separately loaded OpenTUI copies.
      pressed = event.target?.selectable ? linkAt(renderer, event.x, event.y) : undefined
    }
    if (event.type !== "up") return
    const url = pressed
    pressed = undefined
    // OpenTUI marks even a stationary selectable-text click as isDragging until mouse-up finishes.
    if (dragged || renderer.getSelection()?.getSelectedText() || !url) return
    if (linkAt(renderer, event.x, event.y) !== url) return
    event.preventDefault()
    open(url)
  }
  root.processMouseEvent = handler
  return () => {
    active = false
    if (root.processMouseEvent === handler) root.processMouseEvent = previous
  }
}
