import type { Item } from "./rpc"

export function githubURL(value: string) {
  if (!URL.canParse(value.trim())) return
  const url = new URL(value.trim())
  if (url.protocol !== "https:" || url.username || url.password || url.port) return
  if (!["github.com", "www.github.com", "api.github.com"].includes(url.hostname)) return
  const path = url.hostname === "api.github.com" ? url.pathname.replace(/^\/repos\//, "/") : url.pathname
  const match = /^\/([\w.-]+)\/([\w.-]+)\/(issues|pulls?)\/([1-9]\d*)(?:\/(files|commits|checks|changes))?\/?$/.exec(
    path,
  )
  if (!match || !Number.isSafeInteger(Number(match[4]))) return
  const kind: Item["kind"] = match[3] === "issues" ? "issue" : "pr"
  if (kind === "issue" && match[5]) return
  return {
    owner: match[1],
    repo: match[2],
    repository: `${match[1]}/${match[2]}`,
    kind,
    number: Number(match[4]),
    url: `https://github.com/${match[1]}/${match[2]}/${kind === "pr" ? "pull" : "issues"}/${match[4]}`,
  }
}

export function reference(value: string): Item {
  const identity = githubURL(value)
  if (!identity) throw new Error("Enter a GitHub issue or pull request URL.")
  return {
    kind: identity.kind,
    number: identity.number,
    title: `${identity.kind === "pr" ? "PR" : "Issue"} #${identity.number}`,
    url: identity.url,
    repository: identity.repository,
    state: "unknown",
    author: "ghost",
    labels: [],
    body: "",
    bodyLoaded: false,
    comments: [],
    commentsLoaded: false,
    files: null,
  }
}
