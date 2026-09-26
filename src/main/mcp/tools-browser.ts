/**
 * 浏览器工具：**融合缩减**版（`#31` 用户决策）。
 *
 * 目标：接口尽可能少，但能力不缩水。
 * - **不再有 `pageId`**：一律作用于「当前打开的那个 MonoSpace 页面」——
 *   页面由 App 的界面打开（登录 / 同步等入口），agent 只操作它。
 * - 28 个工具融合成 5 个：`dom` / `screenshot` / `script` / `act` / `errors`。
 *   输入能力（click/dblclick/hover/drag/fill/type/press_key/upload/scroll）全部
 *   收进 `act`，按 `action` 分派，一个接口覆盖完整操作面。
 *
 * 与其它浏览器 MCP 的区别只有两点：`monospace_` 命名 + 作用域是本 App 的内置会话。
 */
import { z } from 'zod'
import type { McpHost, McpToolSpec } from './tools'
import { BROWSER_SCOPE, TOOL_PREFIX } from './tools'

/** 元素引用：来自最近一次 `monospace_dom`。 */
const uid = z.string().describe('元素在**最近一次** monospace_dom 结果里的 uid。必须用最新结果。')

const includeSnapshot = z
  .boolean()
  .optional()
  .describe('动作完成后是否再附带一次页面 DOM。默认 false。')

function tool(spec: Omit<McpToolSpec, 'layer'> & { layer?: McpToolSpec['layer'] }): McpToolSpec {
  return {
    ...spec,
    layer: spec.layer ?? 'L1',
    description: `${spec.description}\n\n${BROWSER_SCOPE}`,
  }
}

/** 浏览器工具全集（5 个）。 */
export function createBrowserTools(host: McpHost): McpToolSpec[] {
  return [
    tool({
      name: `${TOOL_PREFIX}dom`,
      title: 'MonoSpace 页面：取 DOM',
      description:
        '取当前 MonoSpace 页面的 DOM（基于无障碍树，已剪枝成紧凑文本）。' +
        '每个可交互元素带 uid，后续 monospace_act 就用这个 uid。**永远使用最新结果**。' +
        '响应同时给出页面 url 与 title，便于确认自己在哪一页。',
      layer: 'L0',
      inputSchema: {
        filePath: z
          .string()
          .optional()
          .describe('把结果写到文件而不是内联返回（页面大时强烈建议）'),
        verbose: z.boolean().optional().describe('是否带上无障碍树里所有可用信息。默认 false。'),
      },
      run: async (input) => {
        const page = await host.browserCurrentPage()
        return host.browserTakeSnapshot(page.pageId, {
          filePath: input.filePath as string | undefined,
          verbose: input.verbose as boolean | undefined,
        })
      },
    }),

    tool({
      name: `${TOOL_PREFIX}screenshot`,
      title: 'MonoSpace 页面：截图',
      description: '截取当前页面，或按 uid 只截某个元素。',
      layer: 'L0',
      inputSchema: {
        uid: uid.optional().describe('只截该元素；不给则截整页视口'),
        fullPage: z.boolean().optional().describe('截整页（与 uid 互斥）'),
        format: z.enum(['png', 'jpeg', 'webp']).optional(),
        quality: z.number().optional().describe('jpeg/webp 压缩质量 0-100'),
        filePath: z.string().optional().describe('把图存到该路径，而不是内联返回'),
      },
      run: async (input) => {
        const page = await host.browserCurrentPage()
        const shot = await host.browserTakeScreenshot(page.pageId, {
          uid: input.uid as string | undefined,
          fullPage: input.fullPage as boolean | undefined,
          format: input.format as 'png' | 'jpeg' | 'webp' | undefined,
          quality: input.quality as number | undefined,
          filePath: input.filePath as string | undefined,
        })
        // 内联返回图片，别把它塞进 JSON 文本里。
        if (shot.data) {
          return {
            content: [
              { type: 'image' as const, data: shot.data, mimeType: `image/${shot.format}` },
            ],
          }
        }
        return shot
      },
    }),

    tool({
      name: `${TOOL_PREFIX}script`,
      title: 'MonoSpace 页面：执行脚本',
      description:
        '在当前页面里执行一个 JavaScript 函数，结果按 JSON 返回（返回值必须可 JSON 序列化）。' +
        '示例：`() => document.title`、`async () => await fetch("...")`、`(el) => el.innerText`。',
      inputSchema: {
        function: z.string().describe('要执行的 JavaScript 函数声明'),
        args: z.array(z.unknown()).optional().describe('传给该函数的参数列表'),
        filePath: z.string().optional().describe('把输出写到文件而不是内联返回'),
        waitForStableDom: z.boolean().optional().describe('是否等 DOM 稳定；只读脚本可传 false'),
      },
      run: async (input) => {
        const page = await host.browserCurrentPage()
        return host.browserEvaluateScript(page.pageId, input.function as string, {
          args: input.args as unknown[] | undefined,
          filePath: input.filePath as string | undefined,
          waitForStableDom: input.waitForStableDom as boolean | undefined,
        })
      },
    }),

    tool({
      name: `${TOOL_PREFIX}act`,
      title: 'MonoSpace 页面：操作',
      description:
        '在页面上执行一个动作。能力完整，按 `action` 分派：\n' +
        '- `click` / `dblclick`：点 uid 元素\n' +
        '- `hover`：悬停到 uid 元素\n' +
        '- `drag`：把 uid 拖到 toUid\n' +
        '- `fill`：往 uid 输入框填 value（复选框/开关用 "true"/"false"，单选传 "true"）\n' +
        '- `type`：在当前聚焦处键入 text（可选结束时按 key）\n' +
        '- `press_key`：按键或组合键，如 "Enter"、"Control+A"、"Control+Shift+R"\n' +
        '- `upload`：经 uid 上传 filePaths\n' +
        '- `scroll`：按 direction 滚动（up/down），可给 amount（像素）\n' +
        '- `goto`：跳转到 url\n' +
        '- `dialog`：处理 alert/confirm/prompt（用 accept 决定接受或取消）',
      inputSchema: {
        action: z.enum([
          'click',
          'dblclick',
          'hover',
          'drag',
          'fill',
          'type',
          'press_key',
          'upload',
          'scroll',
          'goto',
          'dialog',
        ]),
        uid: uid.optional(),
        toUid: uid.optional().describe('`drag` 的落点元素'),
        value: z.string().optional().describe('`fill` 要填入的值'),
        text: z.string().optional().describe('`type` 要键入的文本'),
        key: z.string().optional().describe('`press_key` 的键；`type` 时作为结束按键'),
        filePaths: z.array(z.string()).optional().describe('`upload` 的文件路径'),
        direction: z.enum(['up', 'down']).optional().describe('`scroll` 的方向'),
        amount: z.number().optional().describe('`scroll` 的像素量，默认 800'),
        url: z.string().optional().describe('`goto` 的目标 URL'),
        accept: z.boolean().optional().describe('`dialog`：true 接受，false 取消'),
        promptText: z.string().optional().describe('`dialog` 且是 prompt 时的回复文本'),
        includeSnapshot,
      },
      run: async (input) => {
        const page = await host.browserCurrentPage()
        const pageId = page.pageId
        const target = input.uid as string | undefined
        const snap = input.includeSnapshot as boolean | undefined
        switch (input.action as string) {
          case 'click':
            return host.browserClick(pageId, require(target, 'click 需要 uid'), {
              includeSnapshot: snap,
            })
          case 'dblclick':
            return host.browserClick(pageId, require(target, 'dblclick 需要 uid'), {
              dblClick: true,
              includeSnapshot: snap,
            })
          case 'hover':
            return host.browserHover(pageId, require(target, 'hover 需要 uid'), {
              includeSnapshot: snap,
            })
          case 'drag':
            return host.browserDrag(
              pageId,
              require(target, 'drag 需要 uid'),
              require(input.toUid as string | undefined, 'drag 需要 toUid'),
              { includeSnapshot: snap },
            )
          case 'fill':
            return host.browserFill(
              pageId,
              require(target, 'fill 需要 uid'),
              require(input.value as string | undefined, 'fill 需要 value'),
              { includeSnapshot: snap },
            )
          case 'type':
            return host.browserTypeText(
              pageId,
              require(input.text as string | undefined, 'type 需要 text'),
              {
                submitKey: input.key as string | undefined,
              },
            )
          case 'press_key':
            return host.browserPressKey(
              pageId,
              require(input.key as string | undefined, 'press_key 需要 key'),
              {
                includeSnapshot: snap,
              },
            )
          case 'upload':
            return host.browserUploadFile(
              pageId,
              require(target, 'upload 需要 uid'),
              require(input.filePaths as string[] | undefined, 'upload 需要 filePaths'),
              { includeSnapshot: snap },
            )
          case 'scroll':
            return host.browserScroll(
              pageId,
              (input.direction as 'up' | 'down') ?? 'down',
              input.amount as number | undefined,
            )
          case 'goto':
            return host.browserNavigatePage(pageId, {
              type: 'url',
              url: require(input.url as string | undefined, 'goto 需要 url'),
            })
          case 'dialog':
            return host.browserHandleDialog(
              pageId,
              input.accept === false ? 'dismiss' : 'accept',
              input.promptText as string | undefined,
            )
          default:
            return { error: `不支持的动作：${input.action}` }
        }
      },
    }),

    tool({
      name: `${TOOL_PREFIX}errors`,
      title: 'MonoSpace 页面：获取错误',
      description:
        '取当前页面自上次导航以来的错误信息：控制台消息（默认只给 error/warning）与失败的网络请求。' +
        '页面「看起来没反应」时先看这里。',
      layer: 'L0',
      inputSchema: {
        types: z
          .array(z.string())
          .optional()
          .describe('控制台消息类型过滤，如 ["error"]、["error","warning"]；不给则用默认'),
        includeStackTraces: z.boolean().optional(),
        limit: z.number().int().optional().describe('最多返回多少条，默认 50'),
      },
      run: async (input) => {
        const page = await host.browserCurrentPage()
        return host.browserErrors(page.pageId, {
          types: input.types as string[] | undefined,
          includeStackTraces: input.includeStackTraces as boolean | undefined,
          limit: input.limit as number | undefined,
        })
      },
    }),
  ]
}

/** 参数缺失时给一句能照着做的错误，而不是让下游抛 `undefined`。 */
function require<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(`参数缺失：${message}`)
  return value
}
