# OpenCode GitHub Browser

A GitHub reader inside OpenCode 2. Search issues and pull requests, follow links, read descriptions and discussions, and inspect diffs without leaving the TUI or starting a model turn.

## Install from npm

Available on npm as [`opencode-github-browser`](https://www.npmjs.com/package/opencode-github-browser). Add it to `plugins` in your global `~/.config/opencode/opencode.jsonc` (or `$XDG_CONFIG_HOME/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-github-browser@0.1.0"],
}
```

Keep any existing plugin entries. OpenCode installs the package automatically, including its TUI plugin. Requires **OpenCode 2 beta** (tested with `0.0.0-beta-19157`) and **GitHub CLI** authenticated on the machine running the OpenCode server:

```sh
gh auth login
opencode2 service restart
```

Reopen the TUI and run `/github` in a GitHub project.

Browser search, details, discussion comments, and changed files load directly through **GitHub CLI (`gh`)** on the OpenCode server. These are read-only requests using `gh`'s existing authentication, without a model turn. Chat mentions and agent tool results never populate the browser or its caches. Press **t** to open a conversation about an item, then type in OpenCode's normal prompt.

## Use it

Run `/github` while working in a project. A fresh panel automatically loads open issues from that project’s GitHub repository, resolved by `gh` in the server’s project directory (including worktrees). Switch to **PRs** to fetch its pull requests. **Issues** and **PRs** use repository results with normal pagination, independently of the conversation. Existing browser searches are restored. Press `i` for **Current repository issues** to return to the default list.

Click a rendered `github.com` issue or PR link in the conversation or the browser's Markdown to open it in the current GitHub panel. Links between items stay in the panel, with Back history. You can also paste a link with `/github https://github.com/owner/repo/issues/123`, or press `o` inside the browser. Outside a session, opening a link creates a GitHub session.

Opening a link displays its details without adding it to the results list. **Back to results** restores the existing browser search; in a fresh session it loads the normal first page of the active project's open issues, 50 per page. Lists produced in chat never become browser results.

For direct search, click **/ search** or press `/` inside the focused panel and enter words or GitHub filters, such as `is:open label:bug`. Searches automatically use the current project’s repository. An explicit `repo:`, `org:`, or `user:` overrides that scope. The current Issues/PRs filter applies to the query; switching tabs runs the corresponding search. If no GitHub repository can be resolved, the panel explains how to search another repository or open a URL; it does not silently search all of GitHub. Results load 50 at a time; `m` loads the next page. A new search replaces the visible results while retaining previously fetched items in the cache. GitHub exposes at most 1,000 results for a search; narrow broad queries with repository, state, or label qualifiers.

`/github` (or `/issues`) opens and focuses the panel. The command palette also contains **Open GitHub browser**. Mentioning an issue in chat does not change the list or fetch its data. Click an issue/PR link to explicitly open that item. Refreshes preserve focus and fullscreen presentation.

| Interaction                      | Action                                                       |
| -------------------------------- | ------------------------------------------------------------ |
| Left-click a row / Enter / Right | Open it in the current panel                                 |
| Up / Down or `k` / `j`           | Select a row, or scroll details/diff                         |
| Page Up / Page Down              | Page through results or the current document                 |
| Home / End                       | First/last result or start/end of the document               |
| `n` / `p` in details             | Next/previous result                                         |
| `t`                              | Open a conversation about the selected item                  |
| `v`                              | Load/view a PR diff directly                                 |
| `l` / `c`                        | Refresh details / load discussion comments                   |
| `o`                              | Paste an issue or PR URL to open internally                  |
| `/`                              | Search GitHub directly through gh                            |
| `m`                              | Load the next page of search results                         |
| `s`                              | Filter the results already displayed                         |
| `x`                              | Clear the local text filter                                  |
| `r`                              | Open referenced issues/PRs; retry when a request failed      |
| Tab                              | Browse Issues / PRs                                          |
| `f`                              | Toggle panel fullscreen                                      |
| Escape / Left / Backspace        | Cancel a pending load, then diff → details → results → close |
| `i`                              | Return to open issues in the current repository              |
| `?`                              | Open the searchable GitHub actions menu                      |
| `q`                              | Close the panel and return to the conversation               |

When inactive, the footer shows how to focus GitHub; its letter, arrow, and paging shortcuts are disabled. Use OpenCode's pane-focus shortcuts (shown using your configured bindings), click the pane, or run `/github`. The host may use the first click on an inactive pane solely to focus it. Opening an item conversation focuses the normal prompt, with the reference alongside it when the terminal is wide enough.

Results use two lines per item, with an ellipsis on long titles and compact metadata. The highlighted row expands to show its full title; selecting another row collapses it again. A shared repository is shown once in the header. Press `?` for the full set of available actions.

Opening or previewing an item shows cached data immediately and automatically loads missing details. Loading uses a reserved status row with a small animated spinner, so it cannot overlap results or move the list. Existing results and descriptions stay readable during refresh. Authentication/network errors appear in the panel; press `r` to retry the failed request or Escape to cancel a pending load. Missing CLI, sign-in, timeout, rate-limit, and inaccessible-item errors include an actionable message. Failed diff loads return to usable details. Local filters can be cleared with `x`; the header shows matching results and the search total. Back restores the previous item or result selection and scroll position. Navigation and filters are remembered per session for this TUI's lifetime. Opening a dedicated tab pins the reference without starting a model request; reopening an already-open item focuses its tab. Enable tabs in OpenCode settings for the tab strip. Narrow terminals use the host's fullscreen panel presentation.

Internal link clicks use OpenTUI's rendered hyperlink metadata, including Markdown labels and links with query strings/fragments. Text selection and unrelated links retain their normal handling. Terminal-emulator shortcuts that open OSC-8 links externally are handled by the terminal itself. OpenCode currently has no public link-click registration API, so `src/tui/links.ts` isolates a removable OpenTUI compatibility adapter; `/github <url>` also works independently of that adapter.

### Images

Descriptions and discussion comments render Markdown images and GitHub HTML `<img>` attachments with OpenTUI’s native image renderer. Previews fit the pane and use at most 12 rows; click an image to expand or collapse it. OpenTUI chooses the terminal’s supported image protocol automatically, with a character-cell fallback. Loading and failed previews keep the surrounding text readable; click a failed preview’s caption to retry. Back and closing the pane cancel pending image requests.

GitHub-hosted PNG, JPEG, GIF, and WebP attachments load through the server’s authenticated `gh`, including when the TUI connects remotely. Successful downloads are cached separately for five minutes (16 entries, up to 8 MB each). External image hosts, unsupported formats, and unavailable attachments show a text fallback. Code examples containing image markup remain code and never trigger downloads.

### PR diffs

The viewer reuses OpenTUI's `DiffRenderable`, the same rendering primitive as OpenCode's built-in diff viewer. In a diff, `[` / `]` move between files, `c` opens the changed-file picker, and `v` switches unified/split rendering. Split rendering requires at least 90 columns; use fullscreen for more space. Press `l` while viewing a diff to refresh its changed files. The compact diff footer keeps more space available for code on narrow terminals.

Discussion shows whether comments are unloaded, loaded, or empty. These are issue/PR conversation comments; inline PR review threads and checks are not currently included. Direct comment and changed-file reads follow all pages returned by GitHub. Binary files and files without a GitHub-supplied patch are labeled explicitly. GitHub's API limits still apply (including its maximum of 3,000 changed files per PR).

Descriptions and comments render Markdown headings, emphasis, task lists, nested quotes, tables, code blocks, and images. Links show their labels instead of repeating full URLs. Bare GitHub URLs display compact issue/PR references. References such as `#123` use the item’s repository; `owner/repo#123` can jump across repositories. Click a reference or press `r` to choose from references in the loaded description and comments. Both open inside the panel, and Back restores the previous discussion and scroll position. Code examples stay literal and text selection still works.

## Item conversations

The browser uses direct GitHub reads. Per-session serialization and monotonic revisions preserve updates, and durable storage restores the latest browser view.

The actions dialog groups available commands under **Browse**, **Item**, and **View**. **Open conversation about this item** (`t`) opens or focuses a dedicated session with the issue/PR pinned. New conversations inherit the originating session's agent and model, including its model variant. Opening a conversation leaves it idle: no prompt or synthetic message is queued. Type normally to discuss, implement, or review the item.

Dedicated conversations carry the reference URL in session metadata. A server-side context hook supplies the pinned description and loaded comments when a model request actually runs. This keeps context out of the pending inbox and chat transcript, retains it across plugin restarts, and picks up refreshed details and comments. Browsing related items does not change which reference the conversation is about. Ordinary browsing sessions receive no added model context.

### Caching and refresh

The TUI uses **TanStack Query Core** for resource caching, concurrent request sharing, and infinite search pagination. Results stay fresh for one minute and unused queries are collected after five minutes. Returning to a fresh search restores its loaded pages. Query keys include the server location, search scope, item, and requested part. The query client lives for the TUI plugin's lifetime and is cleared on unload.

Only explicit browsing actions fetch data. Pure search/read RPCs never save session state or emit navigation events; separate save operations persist results after the user requests them. Background cache activity cannot navigate the pane or populate conversation context. Escape/Back detaches the caller and aborts the underlying request when no other pane needs it. Refresh bypasses both the TUI and server response caches. The terminal uses Query Core directly because the Solid web adapter detects Bun as an SSR environment.

Successful GitHub responses are cached for one minute in the server plugin instance, with up to 128 entries. Repository detection is cached for five minutes. Identical concurrent reads reuse the completed response; different queries, pages, kinds, and project directories remain separate. Failed requests are not retained. Canceling a request interrupts its CLI operation.

The server persists only the latest browser view and an explicitly pinned conversation item. Reopening a panel restores its previous contents; TanStack retains recently loaded searches and item parts for reuse. Saved views and RPC responses use the current schema, including required revision markers and the original search text. Press `l` to refresh the current list or details; refreshing a list starts at page one. Existing content remains visible if a refresh fails.

## Development

To work on the plugin source, clone this repository and run:

```sh
bun install
bun run build
bun typecheck
bun test
```

The server uses OpenCode's native `@opencode-ai/plugin/effect` entrypoint and its plugin lifetime scope. Effect is pinned to `4.0.0-rc.112`, matching OpenCode beta `19157`; upgrade those dependencies together. See [AGENTS.md](AGENTS.md) for the adapted OpenCode conventions.

The source follows the runtime boundaries:

```text
src/
  server/   # Effect services, GitHub CLI, storage, and plugin activation
  shared/   # RPC contracts and GitHub URL/reference helpers
  tui/      # Solid reader, diffs, navigation, and host integration

test/
  server/
  shared/
  tui/
  helpers.ts
```

Server and TUI modules depend on shared contracts; shared code does not depend on either runtime. Tests mirror these folders. The root entrypoints expose the server plugin, TUI plugin, and RPC contract.

- `src/server/github.ts`: `GhCommand` owns the interruptible CLI boundary; `GitHubClient` owns read/search operations and response validation.
- `src/server/images.ts`: authenticated attachment downloads, bounded image caching, and cancellation.
- `src/server/store.ts`: `FeedStorage` adapts host storage; `FeedStore` uses scoped per-session semaphores to serialize reads/writes and maintain revisions. Browser-only snapshots use the `browser.v2/` storage namespace.
- `src/server/index.ts`: builds layers in the host scope, registers RPC and the conversation context hook, and maps typed failures to RPC errors. Event delivery failures are logged after the durable view is saved.
- `src/shared/rpc.ts`: Effect Schema contracts exposed through plain Standard Schema adapters, including resource reads and explicit view saves. Native schema ASTs stay in the plugin runtime.
- `src/server/reader.ts`: validates GitHub REST responses and returns session-independent resources.
- `src/server/view.ts`: merges explicitly requested resources into the durable browser view.
- `src/tui/query.ts`: TanStack query keys, cache policy, infinite pagination, and cancellation ownership.
- `src/tui/index.tsx`, `src/tui/browser.tsx`, `src/tui/diff.tsx`: Solid navigation and rendering. `src/tui/links.ts` isolates the link-click compatibility adapter.

Tests exercise the actual services, shared schemas, activation lifetime, and reader components at 45 and 110 columns. They use local fixtures and do not call GitHub or start model requests. Renderer captures are written to the ignored `captures/` directory.

Optionally run `bun run effect:prepare` to bootstrap an ignored Effect source checkout under `.repos/effect` for local research. It leaves an existing checkout unchanged. Runtime APIs are verified against the pinned installed Effect version.

### Publishing

From this repository, run:

```sh
bun typecheck
bun test
npm pack --dry-run
npm login
npm publish
```

Packing or publishing automatically builds `dist/tui.js` with OpenTUI's Solid compiler. Runtime dependencies stay external so OpenCode can supply its shared TUI runtime. The npm package includes this compiled TUI entrypoint and the server/shared TypeScript source for the server and RPC entrypoints.
