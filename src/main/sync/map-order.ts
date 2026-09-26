/**
 * 订单列表 → 数据层领域对象映射（ADR-0003）。
 *
 * 接口**只提供订单列表**：实测 `GET /api/v1/user/order` 的每一项只有 `{ gamekey }`
 * （没有商品名、没有日期、没有 key）。所以这里除了 `remoteId` 什么都给不了，
 * 也**不再建任何 key / 资产包**——那些只从页面读取（见 `data/page-ingest.ts`）。
 *
 * 两个必然的行为变化（如实记录，不掩盖）：
 * 1. 以前能靠订单详情把电子书等非资产订单 **skip 掉**（实测跳过 3 单）；现在没有详情，
 *    分不出来了，**全部保留**。非资产订单会出现在订单列表里，要等页面读过后才看得出。
 * 2. 同步**不再提供商品名 / 购买时间**，所以订单列表在「读过页面」之前只有 gamekey。
 */
import type { SyncedOrder } from '../data/types'
import type { OrderListItem } from './humble-client'

export type { OrderListItem } from './humble-client'

/** 列表项 → SyncedOrder：不建任何 bundle / key（接口拿不到，页面才有）。 */
export function mapOrderListItem(item: OrderListItem): SyncedOrder {
  return {
    remoteId: item.gamekey.trim(),
    productName: undefined,
    purchasedAt: undefined,
    currency: undefined,
    bundles: [],
  }
}

/** 批量映射。 */
export function mapOrders(items: readonly OrderListItem[]): SyncedOrder[] {
  return items.map(mapOrderListItem)
}
