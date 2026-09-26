/**
 * 浏览器工具的**忠实镜像**（`#31` 用户决策：照 Chrome MCP 来，只加「作用域 + 命名」约束）。
 *
 * 工具名 = `monospace_` + Chrome MCP 的原始工具名（`click` → `monospace_click`），
 * 参数名与语义也对齐（`pageId` / `uid` / `includeSnapshot` …），
 * 这样熟悉 Chrome MCP 的 agent 不需要重新学一套。
 *
 * 与 Chrome MCP 的**唯一**差别：只作用于 MonoSpace 内置会话的窗口。
 * 不额外加域白名单、不限流、不做额外的权限拦截。
 */
import { z } from 'zod'
import type { McpHost, McpToolSpec } from './tools'
import { BROWSER_SCOPE, TOOL_PREFIX } from './tools'

/** 页面定位参数（几乎每个工具都要）。 */
const pageId = z.number().int().describe('目标页面的 ID；用 monospace_list_pages 查询。')
const uid = z
  .string()
  .describe('元素在**最近一次**快照里的 uid（来自 monospace_take_snapshot）。必须用最新快照。')
const includeSnapshot = z
  .boolean()
  .optional()
  .describe('是否在响应里附带一次新的页面快照。默认 false。')

function tool(spec: Omit<McpToolSpec, 'layer'> & { layer?: McpToolSpec['layer'] }): McpToolSpec {
  return {
    ...spec,
    layer: spec.layer ?? 'L1',
    description: `${spec.description}\n\n${BROWSER_SCOPE}`,
  }
}

/** 浏览器类工具全集（对齐 Chrome MCP 的默认分类：input / navigation / emulation / network / debugging / performance）。 */
export function createBrowserTools(host: McpHost): McpToolSpec[] {
  return [
    // —————————————————————— Input automation ——————————————————————
    tool({
      name: `${TOOL_PREFIX}click`,
      title: 'MonoSpace 浏览器：点击元素',
      description: '点击（提供 uid 指定的）元素。',
      inputSchema: { pageId, uid, dblClick: z.boolean().optional(), includeSnapshot },
      run: (input) =>
        host.browserClick(input.pageId as number, input.uid as string, {
          dblClick: input.dblClick as boolean | undefined,
          includeSnapshot: input.includeSnapshot as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}click_at`,
      title: 'MonoSpace 浏览器：按坐标点击',
      description: '在指定坐标点击（照 Chrome MCP 的 click_at，视觉兜底用）。',
      inputSchema: {
        pageId,
        x: z.number().describe('横坐标'),
        y: z.number().describe('纵坐标'),
        dblClick: z.boolean().optional(),
        includeSnapshot,
      },
      run: (input) =>
        host.browserClickAt(input.pageId as number, input.x as number, input.y as number, {
          dblClick: input.dblClick as boolean | undefined,
          includeSnapshot: input.includeSnapshot as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}hover`,
      title: 'MonoSpace 浏览器：悬停',
      description: '把鼠标悬停到指定元素上。',
      inputSchema: { pageId, uid, includeSnapshot },
      run: (input) =>
        host.browserHover(input.pageId as number, input.uid as string, {
          includeSnapshot: input.includeSnapshot as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}drag`,
      title: 'MonoSpace 浏览器：拖拽',
      description: '把一个元素拖到另一个元素上。',
      inputSchema: { pageId, from_uid: uid, to_uid: uid, includeSnapshot },
      run: (input) =>
        host.browserDrag(input.pageId as number, input.from_uid as string, input.to_uid as string, {
          includeSnapshot: input.includeSnapshot as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}fill`,
      title: 'MonoSpace 浏览器：填值',
      description:
        '往输入框 / 文本域填入文本，或在 <select> 里选一项。复选框与开关用 "true"/"false"，单选按钮传 "true"。',
      inputSchema: { pageId, uid, value: z.string().describe('要填入的值'), includeSnapshot },
      run: (input) =>
        host.browserFill(input.pageId as number, input.uid as string, input.value as string, {
          includeSnapshot: input.includeSnapshot as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}fill_form`,
      title: 'MonoSpace 浏览器：批量填表',
      description:
        '一次填多个表单元素（输入框 / 下拉 / 复选框 / 单选）。**处理表单时优先用它**，比连着调多次 fill/click 更快更稳。',
      inputSchema: {
        pageId,
        elements: z
          .array(z.object({ uid, value: z.string() }))
          .min(1)
          .describe('要填的元素列表'),
        includeSnapshot,
      },
      run: (input) =>
        host.browserFillForm(
          input.pageId as number,
          input.elements as Array<{ uid: string; value: string }>,
          { includeSnapshot: input.includeSnapshot as boolean | undefined },
        ),
    }),
    tool({
      name: `${TOOL_PREFIX}type_text`,
      title: 'MonoSpace 浏览器：键入文本',
      description: '用键盘往**当前已聚焦**的输入里打字（可带一个结束按键）。',
      inputSchema: { pageId, text: z.string(), submitKey: z.string().optional() },
      run: (input) =>
        host.browserTypeText(input.pageId as number, input.text as string, {
          submitKey: input.submitKey as string | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}press_key`,
      title: 'MonoSpace 浏览器：按键',
      description:
        '按一个键或组合键，例如 "Enter"、"Control+A"、"Control++"、"Control+Shift+R"。修饰键可用 Control、Shift、Alt、Meta。',
      inputSchema: { pageId, key: z.string(), includeSnapshot },
      run: (input) =>
        host.browserPressKey(input.pageId as number, input.key as string, {
          includeSnapshot: input.includeSnapshot as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}upload_file`,
      title: 'MonoSpace 浏览器：上传文件',
      description: '经指定元素上传文件；该元素可以是文件输入框，也可以是会唤起文件选择器的按钮。',
      inputSchema: {
        pageId,
        uid,
        filePaths: z.array(z.string()).min(1).describe('一个或多个文件路径'),
        includeSnapshot,
      },
      run: (input) =>
        host.browserUploadFile(
          input.pageId as number,
          input.uid as string,
          input.filePaths as string[],
          {
            includeSnapshot: input.includeSnapshot as boolean | undefined,
          },
        ),
    }),
    tool({
      name: `${TOOL_PREFIX}handle_dialog`,
      title: 'MonoSpace 浏览器：处理对话框',
      description: '若页面弹出了浏览器对话框（alert/confirm/prompt），用它处理。',
      inputSchema: {
        pageId,
        action: z.enum(['accept', 'dismiss']),
        promptText: z.string().optional().describe('prompt 对话框要回复的文本'),
      },
      run: (input) =>
        host.browserHandleDialog(
          input.pageId as number,
          input.action as 'accept' | 'dismiss',
          input.promptText as string | undefined,
        ),
    }),

    // —————————————————————— Navigation automation ——————————————————————
    tool({
      name: `${TOOL_PREFIX}list_pages`,
      title: 'MonoSpace 浏览器：列出页面',
      description: '列出 MonoSpace 内置会话里当前打开的页面。',
      layer: 'L0',
      inputSchema: {},
      run: () => host.browserListPages(),
    }),
    tool({
      name: `${TOOL_PREFIX}select_page`,
      title: 'MonoSpace 浏览器：选中页面',
      description: '选中某个页面作为后续调用的默认页面。',
      layer: 'L0',
      inputSchema: { pageId, bringToFront: z.boolean().optional() },
      run: (input) =>
        host.browserSelectPage(input.pageId as number, {
          bringToFront: input.bringToFront as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}new_page`,
      title: 'MonoSpace 浏览器：新建页面',
      description: '新建一个页面（内置会话的新窗口）并加载 URL。',
      inputSchema: {
        url: z.string().describe('要加载的 URL'),
        background: z.boolean().optional().describe('是否在后台创建（不抢焦点）。默认 false。'),
        timeout: z.number().int().optional(),
      },
      run: (input) =>
        host.browserNewPage(input.url as string, {
          background: input.background as boolean | undefined,
          timeout: input.timeout as number | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}close_page`,
      title: 'MonoSpace 浏览器：关闭页面',
      description: '关掉指定页面。**最后一个页面不能关**（照 Chrome MCP 的行为）。',
      inputSchema: { pageId },
      run: (input) => host.browserClosePage(input.pageId as number),
    }),
    tool({
      name: `${TOOL_PREFIX}navigate_page`,
      title: 'MonoSpace 浏览器：导航',
      description: '前往某个 URL，或后退 / 前进 / 刷新。',
      inputSchema: {
        pageId,
        type: z.enum(['url', 'back', 'forward', 'reload']).optional(),
        url: z.string().optional().describe('目标 URL（仅 type=url 时用）'),
        timeout: z.number().int().optional(),
        ignoreCache: z.boolean().optional().describe('刷新时是否忽略缓存'),
        handleBeforeUnload: z.enum(['accept', 'dismiss']).optional(),
      },
      run: (input) =>
        host.browserNavigatePage(input.pageId as number, {
          type: input.type as 'url' | 'back' | 'forward' | 'reload' | undefined,
          url: input.url as string | undefined,
          timeout: input.timeout as number | undefined,
          ignoreCache: input.ignoreCache as boolean | undefined,
          handleBeforeUnload: input.handleBeforeUnload as 'accept' | 'dismiss' | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}wait_for`,
      title: 'MonoSpace 浏览器：等待文本',
      description: '等到页面上出现指定文本之一（任一命中即返回）。',
      inputSchema: {
        pageId,
        text: z.array(z.string()).min(1).describe('要等待的文本，任一出现即返回'),
        timeout: z.number().int().optional().describe('最长等待毫秒数；0 表示用默认值'),
      },
      run: (input) =>
        host.browserWaitFor(
          input.pageId as number,
          input.text as string[],
          input.timeout as number | undefined,
        ),
    }),

    // —————————————————————— Emulation ——————————————————————
    tool({
      name: `${TOOL_PREFIX}emulate`,
      title: 'MonoSpace 浏览器：仿真',
      description: '在目标页面上仿真深色模式、CPU/网络限速、地理位置、UA、视口、额外请求头等。',
      inputSchema: {
        pageId,
        colorScheme: z.enum(['dark', 'light', 'auto']).optional(),
        cpuThrottlingRate: z.number().optional(),
        extraHttpHeaders: z.string().optional().describe('JSON 字符串对象；空串表示清除'),
        geolocation: z.string().optional().describe('<纬度>,<经度>；不给表示清除'),
        networkConditions: z
          .enum(['Offline', 'Slow 3G', 'Fast 3G', 'Slow 4G', 'Fast 4G'])
          .optional(),
        userAgent: z.string().optional().describe('空串表示清除'),
        viewport: z
          .string()
          .optional()
          .describe("'<宽>x<高>x<像素比>[,mobile][,touch][,landscape]'"),
      },
      run: (input) =>
        host.browserEmulate(input.pageId as number, {
          colorScheme: input.colorScheme as 'dark' | 'light' | 'auto' | undefined,
          cpuThrottlingRate: input.cpuThrottlingRate as number | undefined,
          extraHttpHeaders: input.extraHttpHeaders as string | undefined,
          geolocation: input.geolocation as string | undefined,
          networkConditions: input.networkConditions as
            | 'Offline'
            | 'Slow 3G'
            | 'Fast 3G'
            | 'Slow 4G'
            | 'Fast 4G'
            | undefined,
          userAgent: input.userAgent as string | undefined,
          viewport: input.viewport as string | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}resize_page`,
      title: 'MonoSpace 浏览器：调整页面尺寸',
      description: '调整页面窗口尺寸，使页面达到指定宽高。',
      inputSchema: { pageId, width: z.number(), height: z.number() },
      run: (input) =>
        host.browserResizePage(
          input.pageId as number,
          input.width as number,
          input.height as number,
        ),
    }),

    // —————————————————————— Debugging ——————————————————————
    tool({
      name: `${TOOL_PREFIX}take_snapshot`,
      title: 'MonoSpace 浏览器：取页面快照',
      description:
        '基于无障碍树取页面文本快照。快照里每个元素带唯一 uid，后续 click/fill 都用这个 uid。' +
        '**永远使用最新快照**；能用快照就别用截图。',
      layer: 'L0',
      inputSchema: {
        pageId,
        filePath: z.string().optional().describe('把快照写到文件而不是内联返回'),
        verbose: z.boolean().optional().describe('是否带上无障碍树里所有可用信息。默认 false。'),
      },
      run: (input) =>
        host.browserTakeSnapshot(input.pageId as number, {
          filePath: input.filePath as string | undefined,
          verbose: input.verbose as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}take_screenshot`,
      title: 'MonoSpace 浏览器：截图',
      description: '截取页面或某个元素的图。',
      layer: 'L0',
      inputSchema: {
        pageId,
        uid: z.string().optional().describe('只截该元素；不给则截整页视口'),
        filePath: z.string().optional().describe('把图存到该路径，而不是内联返回'),
        format: z.enum(['png', 'jpeg', 'webp']).optional(),
        fullPage: z.boolean().optional().describe('截整页（与 uid 互斥）'),
        quality: z.number().optional().describe('jpeg/webp 压缩质量 0-100'),
      },
      run: (input) =>
        host.browserTakeScreenshot(input.pageId as number, {
          uid: input.uid as string | undefined,
          filePath: input.filePath as string | undefined,
          format: input.format as 'png' | 'jpeg' | 'webp' | undefined,
          fullPage: input.fullPage as boolean | undefined,
          quality: input.quality as number | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}evaluate_script`,
      title: 'MonoSpace 浏览器：执行页面脚本',
      description:
        '在目标页面里执行一个 JavaScript 函数，结果按 JSON 返回（因此返回值必须可 JSON 序列化）。' +
        '示例：`() => document.title`、`async () => await fetch("...")`、`(el) => el.innerText`。',
      inputSchema: {
        pageId,
        function: z.string().describe('要执行的 JavaScript 函数声明'),
        args: z.array(z.unknown()).optional().describe('传给该函数的参数列表'),
        dialogAction: z
          .string()
          .optional()
          .describe('"accept" / "dismiss"，或作为 prompt 回复的文本'),
        filePath: z.string().optional().describe('把输出写到文件而不是内联返回'),
        waitForStableDom: z.boolean().optional().describe('是否等 DOM 稳定；只读脚本可传 false'),
      },
      run: (input) =>
        host.browserEvaluateScript(input.pageId as number, input.function as string, {
          args: input.args as unknown[] | undefined,
          dialogAction: input.dialogAction as string | undefined,
          filePath: input.filePath as string | undefined,
          waitForStableDom: input.waitForStableDom as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}list_console_messages`,
      title: 'MonoSpace 浏览器：控制台消息列表',
      description: '列出目标页面自上次导航以来的控制台消息。',
      layer: 'L0',
      inputSchema: {
        pageId,
        includePreservedMessages: z.boolean().optional().describe('是否包含最近 3 次导航的历史'),
        includeStackTraces: z.boolean().optional(),
        pageIdx: z.number().int().optional(),
        pageSize: z.number().int().optional(),
        types: z.array(z.string()).optional().describe('按消息类型过滤'),
      },
      run: (input) =>
        host.browserListConsoleMessages(input.pageId as number, {
          includePreservedMessages: input.includePreservedMessages as boolean | undefined,
          includeStackTraces: input.includeStackTraces as boolean | undefined,
          pageIdx: input.pageIdx as number | undefined,
          pageSize: input.pageSize as number | undefined,
          types: input.types as string[] | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}get_console_message`,
      title: 'MonoSpace 浏览器：单条控制台消息',
      description: '按 msgid 取一条控制台消息。',
      layer: 'L0',
      inputSchema: {
        pageId,
        msgid: z.number().int().describe('消息 ID，来自 list_console_messages'),
      },
      run: (input) => host.browserGetConsoleMessage(input.pageId as number, input.msgid as number),
    }),
    tool({
      name: `${TOOL_PREFIX}list_network_requests`,
      title: 'MonoSpace 浏览器：网络请求列表',
      description: '列出目标页面自上次导航以来最近的网络请求。',
      layer: 'L0',
      inputSchema: {
        pageId,
        includePreservedRequests: z.boolean().optional().describe('是否包含最近 3 次导航的历史'),
        pageIdx: z.number().int().optional(),
        pageSize: z.number().int().optional(),
        resourceTypes: z.array(z.string()).optional().describe('按资源类型过滤'),
      },
      run: (input) =>
        host.browserListNetworkRequests(input.pageId as number, {
          includePreservedRequests: input.includePreservedRequests as boolean | undefined,
          pageIdx: input.pageIdx as number | undefined,
          pageSize: input.pageSize as number | undefined,
          resourceTypes: input.resourceTypes as string[] | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}get_network_request`,
      title: 'MonoSpace 浏览器：单条网络请求',
      description:
        '按 reqid 取一条网络请求（省略 reqid 时返回当前选中的那条），可看请求头与响应头、可把请求/响应体落盘。',
      layer: 'L0',
      inputSchema: {
        pageId,
        reqid: z.number().int().optional(),
        requestFilePath: z.string().optional(),
        responseFilePath: z.string().optional(),
      },
      run: (input) =>
        host.browserGetNetworkRequest(input.pageId as number, {
          reqid: input.reqid as number | undefined,
          requestFilePath: input.requestFilePath as string | undefined,
          responseFilePath: input.responseFilePath as string | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}get_css_styles`,
      title: 'MonoSpace 浏览器：元素 CSS',
      description:
        '取某个 uid 元素匹配到的 CSS 规则（含 inline、继承、自定义属性、@layer/@media/@container/@scope 包装），' +
        '按层叠优先级从高到低排列，生效的声明无前缀，被覆盖的声明带 [overloaded] 前缀。结果分页（默认每页 10 条）。',
      layer: 'L0',
      inputSchema: {
        pageId,
        uid,
        pageIdx: z.number().int().optional(),
        pageSize: z.number().int().optional(),
      },
      run: (input) =>
        host.browserGetCssStyles(input.pageId as number, input.uid as string, {
          pageIdx: input.pageIdx as number | undefined,
          pageSize: input.pageSize as number | undefined,
        }),
    }),

    // —————————————————————— Performance ——————————————————————
    tool({
      name: `${TOOL_PREFIX}performance_start_trace`,
      title: 'MonoSpace 浏览器：开始性能录制',
      description:
        '在目标页面开始一次性能 trace（用来看前端性能问题、Core Web Vitals、加载速度）。' +
        '要用 reload/autoStop 的话，先导航到目标 URL 再开始录制。',
      inputSchema: {
        pageId,
        autoStop: z.boolean().optional(),
        filePath: z.string().optional().describe('把原始 trace 存到该路径（.json.gz 或 .json）'),
        reload: z.boolean().optional().describe('开始录制后是否自动刷新目标页面'),
      },
      run: (input) =>
        host.browserPerformanceStartTrace(input.pageId as number, {
          autoStop: input.autoStop as boolean | undefined,
          filePath: input.filePath as string | undefined,
          reload: input.reload as boolean | undefined,
        }),
    }),
    tool({
      name: `${TOOL_PREFIX}performance_stop_trace`,
      title: 'MonoSpace 浏览器：停止性能录制',
      description: '停止目标页面上正在进行的性能 trace 录制。',
      inputSchema: { pageId, filePath: z.string().optional() },
      run: (input) =>
        host.browserPerformanceStopTrace(input.pageId as number, {
          filePath: input.filePath as string | undefined,
        }),
    }),
  ]
}
