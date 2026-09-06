import { Plugin } from "@opencode-ai/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, on, Show } from "solid-js"
import { Browser } from "./browser"
import { GitHub, errorMessage, type Feed, type Item } from "../shared/rpc"
import { createIssueSession } from "./session"
import { githubURL, reference } from "../shared/url"
import { registerLinks } from "./links"

export default Plugin.define({
  id: "github-browser.tui",
  setup(context) {
    const [state, update] = context.storage.memory<{
      feeds: Record<string, Feed>
      tabs: Record<string, string>
    }>("viewer.v1", { initial: { feeds: {}, tabs: {} } })
    const opening = new Map<string, Promise<string>>()
    let navigation = 0
    const showPanel = (focus = false) => {
      const route = context.ui.router.current()
      if (route.type === "session" && context.ui.panel.current()?.sessionID !== route.sessionID)
        context.ui.panel.open("github-browser.issues")
      if (focus) queueMicrotask(() => context.keymap.dispatch("pane.focus.right"))
    }
    const createTab = async (item: Item, location: NonNullable<Plugin.Context["location"]>) => {
      const route = context.ui.router.current()
      const source = route.type === "session" ? context.data.session.get(route.sessionID) : undefined
      const { session, feed } = await createIssueSession(context.client, item, location, source)
      update((draft) => {
        draft.tabs[`${location.directory}:${item.url}`] = session.id
        draft.feeds[session.id] = feed
      })
      await context.data.session.sync(session.id)
      return session.id
    }
    const openTab = async (item: Item, location: NonNullable<Plugin.Context["location"]>) => {
      const request = ++navigation
      const key = `${location.directory}:${item.url}`
      const existing = state.tabs[key]
      const available =
        existing &&
        (context.ui.tabs.list().some((tab) => tab.sessionID === existing) ||
          (!context.ui.tabs.enabled() && context.data.session.get(existing)))
      let task = opening.get(key)
      if (!available && !task) {
        task = createTab(item, location)
        opening.set(key, task)
        void task
          .finally(() => {
            if (opening.get(key) === task) opening.delete(key)
          })
          .catch(() => {})
      }
      const sessionID = available ? existing : await task
      if (!sessionID || request !== navigation) return
      context.ui.tabs.open(sessionID)
      context.ui.router.navigate({ type: "session", sessionID })
      context.ui.panel.open("github-browser.issues", { presentation: "panel" })
      queueMicrotask(() => context.keymap.dispatch("pane.focus.left"))
    }
    const openURL = async (value: string) => {
      const identity = githubURL(value)
      if (!identity) throw new Error("Enter a GitHub issue or pull request URL.")
      const route = context.ui.router.current()
      const session = route.type === "session" ? context.data.session.get(route.sessionID) : undefined
      const location = session?.location ?? context.location ?? context.data.location.default()
      if (route.type !== "session") return openTab(reference(identity.url), location)
      const feed = await context.client
        .rpc(GitHub)
        .open({ sessionID: route.sessionID, url: identity.url }, { location })
      update((draft) => {
        if ((feed.revision ?? 0) >= (draft.feeds[route.sessionID]?.revision ?? 0)) draft.feeds[route.sessionID] = feed
      })
      const current = context.ui.router.current()
      if (current.type === "session" && current.sessionID === route.sessionID) showPanel(true)
    }
    const stopLinks = registerLinks(context.renderer, (url) => {
      void openURL(url).catch((error) => context.ui.toast.show({ message: errorMessage(error), variant: "error" }))
    })
    const stop = context.client.rpc(GitHub).events.on("selected", (event) => {
      if ((event.data.feed.revision ?? 0) < (state.feeds[event.data.sessionID]?.revision ?? 0)) return
      update((draft) => {
        draft.feeds[event.data.sessionID] = event.data.feed
        // An /issues/N link can resolve to /pull/N. Reuse the same tab for either URL.
        const item = event.data.feed.items.find((item) => item.url === event.data.feed.selected)
        if (
          item?.kind === "pr" &&
          draft.tabs[`${event.location.directory}:${item.url.replace("/pull/", "/issues/")}`] === event.data.sessionID
        )
          draft.tabs[`${event.location.directory}:${item.url}`] = event.data.sessionID
      })
      const route = context.ui.router.current()
      if (event.data.reveal && route.type === "session" && route.sessionID === event.data.sessionID) showPanel()
    })
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === "github-browser.issues"}>
          <Browser
            context={context}
            sessionID={panel.sessionID}
            feed={state.feeds[panel.sessionID]}
            focused={panel.focused}
            presentation={panel.presentation}
            close={panel.close}
            fullscreen={panel.toggleFullscreen}
            focus={panel.focus}
            width={panel.width}
            openTab={openTab}
            openURL={openURL}
          />
        </Show>
      ),
    })
    context.ui.router.register({
      name: "issues",
      render: () => {
        const dimensions = useTerminalDimensions()
        return (
          <Browser
            context={context}
            close={() => context.ui.router.navigate({ type: "home" })}
            width={dimensions().width}
            openTab={openTab}
            openURL={openURL}
          />
        )
      },
    })
    context.ui.slot({
      append: "app",
      render() {
        createEffect(
          on(
            () => context.ui.router.current(),
            (route) => {
              if (route.type !== "session" || !Object.values(state.tabs).includes(route.sessionID)) return
              showPanel()
            },
          ),
        )
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "github-browser.open",
              title: "Open GitHub browser",
              group: "GitHub",
              palette: true,
              slash: { name: "github", aliases: ["issues"], arguments: true },
              async run(input) {
                context.ui.dialog.clear()
                if (input?.trim()) {
                  try {
                    await openURL(input.trim())
                  } catch (error) {
                    context.ui.toast.show({ message: errorMessage(error), variant: "error" })
                  }
                  return
                }
                if (context.ui.router.current().type === "session") showPanel(true)
                else
                  context.ui.router.navigate({
                    type: "plugin",
                    name: "issues",
                  })
              },
            },
          ],
        }))
        return null
      },
    })
    return () => {
      navigation++
      stop()
      stopLinks()
    }
  },
})
