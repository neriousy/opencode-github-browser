# GitHub browser plugin

Follow the OpenCode v2 conventions in `../opencode/AGENTS.md` when applicable. This repository is a standalone package; run its checks here.

- Organize source by runtime boundary: `src/server` for Effect/server logic, `src/tui` for terminal UI, and `src/shared` for contracts and pure helpers used by both. Shared modules must not import either runtime; mirror these folders under `test`. Keep root package entrypoints thin.
- The product is an in-TUI reader for GitHub issues and PRs. Opening, searching, reading discussions, and viewing diffs must not require a model turn or external browser.
- Default new browser views and unqualified searches to the active project’s repository. Restore repository searches and show the current scope. Chat mentions and agent tool results must not populate the browser or its caches; opening a referenced item requires an explicit user action. Keep browsing separate from explicit discuss/work actions.
- Opening a reference must not add it to search results. Keep the current detail separate from list membership. Back from a direct open restores the browser search, or loads the default 50-item repository page when none exists.
- Keep GitHub requests read-only and server-side, using the server's existing `gh` authentication. Agent discussion/work/review is an explicit user action.
- Use `@opencode-ai/plugin/effect` for server lifecycle, RPC, hooks, and tools. Keep Solid state and the public Promise client at the TUI boundary.
- Match the Effect version used by the pinned OpenCode plugin package. Update them together; do not independently follow a floating Effect prerelease tag.
- Use `Context.Service`, composed `Layer`s, named `Effect.fn` business operations, typed schema errors, and interruption-aware I/O. Bind services before calling their methods.
- Build service layers in the host plugin scope. Registrations and service resources must remain alive after activation and close on unload.
- Validate unknown input at its owning boundary with Effect Schema. Use the Standard Schema adapter for schemas shared with the TUI's portable RPC client. Keep pure normalization synchronous.
- Avoid `any`, type assertions, non-null assertions, TypeScript namespaces, renamed imports, and star imports. Prefer inference, `const`, early returns, and functional array operations.
- Do not add service accessor wrappers or abstractions without a concrete use. Keep helpers near the code they support.
- Target the current browser model and pinned host API. Do not add legacy RPC adapters, old-format migrations, or compatibility defaults for obsolete data shapes.
- Preserve per-session serialization, durable browser state, monotonic revisions, cancellation, and navigation history. Different sessions must not block each other.
- Use semantic theme tokens. Keep keyboard shortcuts inactive when the GitHub pane is unfocused. Check narrow and wide terminals, empty/loading/error states, and the Back path.
- Keep the OpenTUI link compatibility adapter isolated. Preserve text selection and unrelated links.
- Test real services/components with injected boundaries, not duplicated implementations or global mocks. Use the Bun Effect test boundary like OpenCode.
- Run `bun typecheck` and `bun test` before finishing. The test preload must use OpenTUI's Solid compiler.
- Use conventional commit and PR titles. Do not commit generated captures or the ignored Effect research checkout.
