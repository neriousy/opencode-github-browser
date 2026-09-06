import type { BrowserView, Item, ReadResult, SearchPage } from "../shared/rpc"
import { githubURL, reference } from "../shared/url"
import { ViewError } from "./errors"
import type { Snapshot } from "./store"

export function openView(snapshot: Snapshot, requested: Item): BrowserView {
  const item =
    [
      ...(snapshot.feed?.detail ? [snapshot.feed.detail] : []),
      ...(snapshot.feed?.items ?? []),
      ...(snapshot.pinned ? [snapshot.pinned] : []),
    ].find((item) => identityKey(item) === identityKey(requested)) ?? requested
  return {
    ...snapshot.feed,
    items: snapshot.feed?.items ?? [],
    detail: item,
    selected: item.url,
  }
}

export function readView(snapshot: Snapshot, result: ReadResult): BrowserView | ViewError {
  const url = result.part === "details" ? result.item.url : result.url
  const identity = githubURL(url)
  if (!identity) return new ViewError({ message: "Unsupported GitHub issue or pull request URL." })
  const previous =
    [
      ...(snapshot.feed?.detail ? [snapshot.feed.detail] : []),
      ...(snapshot.feed?.items ?? []),
      ...(snapshot.pinned ? [snapshot.pinned] : []),
    ].find((item) => item.repository === identity.repository && item.number === identity.number) ??
    reference(identity.url)
  const item: Item =
    result.part === "details"
      ? mergeDetails(previous, result.item)
      : result.part === "comments"
        ? { ...previous, comments: result.comments, commentsLoaded: true }
        : { ...previous, files: result.files }
  const selected = snapshot.feed?.selected
  const old = selected ? githubURL(selected) : undefined
  return {
    ...snapshot.feed,
    items: (snapshot.feed?.items ?? []).map((row) => (identityKey(row) === identityKey(item) ? item : row)),
    detail: item,
    selected: old?.repository === item.repository && old.number === item.number ? item.url : (selected ?? null),
  }
}

export function searchView(snapshot: Snapshot, pages: readonly SearchPage[], text: string): BrowserView | ViewError {
  const first = pages[0]
  const last = pages.at(-1)
  if (
    !first ||
    !last ||
    pages.some((page, index) => page.query !== first.query || page.kind !== first.kind || page.page !== index + 1)
  )
    return new ViewError({ message: "The search changed. Retry from the current search." })
  const previous = new Map(
    [
      ...(snapshot.pinned ? [snapshot.pinned] : []),
      ...(snapshot.feed?.items ?? []),
      ...(snapshot.feed?.detail ? [snapshot.feed.detail] : []),
    ].map((item) => [identityKey(item), item]),
  )
  const items = pages.flatMap((page) => page.items.map((item) => mergeDetails(previous.get(identityKey(item)), item)))
  return {
    items: [...new Map(items.map((item) => [identityKey(item), item])).values()],
    selected: null,
    search: {
      query: last.query,
      text,
      kind: last.kind,
      page: last.page,
      total: last.total,
      incomplete: last.incomplete,
    },
  }
}

function identityKey(item: Item) {
  return `${item.repository}:${item.number}`
}

function mergeDetails(previous: Item | undefined, item: Item): Item {
  return {
    ...item,
    body: item.bodyLoaded ? item.body : (previous?.body ?? item.body),
    bodyLoaded: item.bodyLoaded || previous?.bodyLoaded === true,
    comments: item.commentsLoaded ? item.comments : (previous?.comments ?? item.comments),
    commentsLoaded: item.commentsLoaded || previous?.commentsLoaded === true,
    files: item.files ?? previous?.files ?? null,
  }
}
