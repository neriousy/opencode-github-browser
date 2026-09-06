/** Only GitHub-hosted attachments are fetched with the server's GitHub credentials. */
export function imageURL(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.port) return
  if (url.hostname.endsWith(".githubusercontent.com") || url.hostname === "githubusercontent.com") return url.href
  if (url.hostname !== "github.com") return
  if (/^\/(user-attachments\/assets|assets)\//.test(url.pathname) || /^\/[^/]+\/[^/]+\/raw\//.test(url.pathname))
    return url.href
}
