import type { Plugin } from "@opencode-ai/plugin/tui"

/** One resolved token set. The host renders split panels in its elevated context, so views take tokens, not the theme. */
export type ThemeTokens = Plugin.Context["theme"]["contextual"]["elevated"]

/** Host capabilities used by the reader; keeps fixtures independent of the rest of the TUI. */
export type BrowserContext = Pick<Plugin.Context, "location" | "client"> & {
  theme: ThemeTokens
  renderer: Pick<Plugin.Context["renderer"], "getSelection">
  storage: Pick<Plugin.Context["storage"], "memory">
  keymap: Pick<Plugin.Context["keymap"], "layer" | "shortcuts" | "dispatch">
  data: {
    session: Pick<Plugin.Context["data"]["session"], "get" | "sync">
    location: Pick<Plugin.Context["data"]["location"], "default">
  }
  ui: {
    dialog: Pick<Plugin.Context["ui"]["dialog"], "prompt" | "select">
    toast: Pick<Plugin.Context["ui"]["toast"], "show">
    tabs: Pick<Plugin.Context["ui"]["tabs"], "open">
    router: Pick<Plugin.Context["ui"]["router"], "navigate">
    panel: Pick<Plugin.Context["ui"]["panel"], "open">
  }
}

/** The browser root also needs the contextual variants to pick tokens for its presentation. */
export type BrowserHost = BrowserContext & Pick<Plugin.Context, "theme">
