/**
 * My Library 回执校验（规格 #12 §6.1 步骤 7）。
 *
 * 最终成功判据是「该 listing 出现在 fab.com/library」，不只信页面提示。
 * 这里只做**纯匹配**：给定页面上的 listing 标题列表与期望商品名，判断是否已入库。
 */

/** 归一化标题：小写、去括号/标点/多余空白，便于宽松比对。 */
export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（(【\[].*?[)）】\]]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * 期望商品是否已在库中。
 * 匹配规则：归一化后全等，或一方是另一方的完整子串（Fab listing 名常带版本/后缀）。
 */
export function findListing(listingTitles: readonly string[], productName: string | null): boolean {
  if (!productName) return false
  const target = normalizeTitle(productName)
  if (!target) return false

  for (const title of listingTitles) {
    const candidate = normalizeTitle(title)
    if (!candidate) continue
    if (candidate === target) return true
    if (candidate.includes(target) || target.includes(candidate)) return true
  }
  return false
}

/** 在标题列表里找出与期望商品最接近的若干条，供 needs_human 时给人看。 */
export function nearestListings(
  listingTitles: readonly string[],
  productName: string | null,
  limit = 3,
): string[] {
  if (!productName) return []
  const target = normalizeTitle(productName)
  if (!target) return []
  return listingTitles
    .filter((title) => {
      const candidate = normalizeTitle(title)
      return candidate.includes(target) || target.includes(candidate)
    })
    .slice(0, limit)
}
