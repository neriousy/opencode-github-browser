import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["./tui.tsx"],
  outdir: "./dist",
  target: "bun",
  packages: "external",
  plugins: [solidPlugin],
})

if (!result.success) throw new AggregateError(result.logs, "TUI build failed")
