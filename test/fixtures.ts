import type { Feed, Item } from "../src/shared/rpc"

export const emptyFeed: Feed = { items: [], selected: null, revision: 0, navigation: 0 }

export function searchFeed(items: readonly Item[], search: Partial<NonNullable<Feed["search"]>> = {}): Feed {
  return {
    items,
    selected: null,
    revision: 1,
    navigation: 1,
    search: {
      query: "repo:owner/repo is:open",
      text: "is:open",
      kind: items[0]?.kind ?? "issue",
      page: 1,
      total: items.length,
      incomplete: false,
      ...search,
    },
  }
}

export function detailFeed(item: Item): Feed {
  return { ...emptyFeed, detail: item, selected: item.url, revision: 1, navigation: 1 }
}
