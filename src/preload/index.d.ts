/**
 * 渲染进程可见的窗口 API 类型。
 *
 * 这里**不再自带台账声明**：`window.api` 的形状（`MonoSpaceApi`）与全部过 IPC 的
 * 数据形状都来自 `src/shared/ipc-contract.ts`（不 import 任何东西的纯类型模块）。
 * preload 实现用同一个接口标注 `api`，所以主进程 / preload / 渲染层三方同源，
 * 字段或方法漂移都会变成编译错误，而不是静默看不见。
 *
 * web 配置只收录本 `.d.ts` 与 shared 契约，主进程的 Node / Electron 类型不会进来。
 */

import type { MonoSpaceApi } from '../shared/ipc-contract'

declare global {
  interface Window {
    api: MonoSpaceApi
  }
}
