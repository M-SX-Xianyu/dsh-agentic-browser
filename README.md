# Agent 浏览器（dsh-agentic-browser）

> DSH 右侧栏的 **Agent 浏览器**面板：接近原生内置浏览器的体验，但由 Agent 直接驱动——22 个 `dsh_agentic_browser_*` 工具、可见的鼠标光标动画、跨会话后台打开、批量操作一次完成。

## 安装

环境要求：**官方 DSH Desktop ≥ 0.2.1-rc.x**（网页载体依赖 `dshDesktop.browser` 桥协议 v1；Web 版装后面板提示“需要 DSH Desktop 运行时”）。依赖 `@deepseek-ai/dsh-tools` 在安装时自动从 DSH 自身解析，无需手动准备。

### 方式一：npm 安装（推荐，可锁版本、可升级）

在 DSH 中让 Agent 执行（或插件管理界面等价操作）：

```
install_bundle  target=dsh-agentic-browser@1.0.0
```

装完**重启 DSH**。以后升级只需把版本号换成最新再执行一次 `install_bundle`。

### 方式二：从 GitHub 源码安装（适合改源码自用）

```bash
git clone https://github.com/YOUR_NAME/dsh-agentic-browser.git
```

然后在 DSH 中：

```
install_bundle  target=D:\path\to\dsh-agentic-browser
```

安装为 pnpm 链接方式：**改源码 → 重启 DSH 即生效**。跑回归测试：`node --test test/`（24 项）。

### 方式三：zip 包安装（离线分发）

拿到 zip 解压到任意目录（**不要**把 `node_modules` 拷进去），然后同方式二执行 `install_bundle` 指向解压目录，重启即可。

### 卸载

```
remove_bundle  target=dsh-agentic-browser
```

## 实现方式

### 总体架构

插件分为 Host 端（Node.js，运行在 DSH 进程内）与 Client 端（运行在页面里的普通 JavaScript），两者之间通过一个插件自有的 HTTP 长轮询通道通信：

```
Agent 工具 → Host（会话/命令队列）→ 长轮询 /poll → Client（面板）
                                              ↓
                                    Electron <webview> 客人页（真实网页）
                                              ↓
                              页面事件/结果 → /event、/result → Host → Agent
```

- **会话与认证**：Client 面板打开时向 Host 注册（按 Agent 会话区分，subagent 自动归并到根会话），Host 发放一次性 64 位十六进制 capability；之后所有命令与事件都凭 `sessionId + clientId + capability` 认证。Origin 头存在时校验其属于应用源或同端口回环别名，Desktop 的 `dsh-app://` 协议桥不带 Origin，此时完全由 capability 承担认证。
- **网页载体**：Desktop 下每个标签页是一个 Electron `<webview>`（内核即 DSH 自带的 Chromium）。主进程只批准 `about:blank#<租约>` 形式的引导挂载，真实导航在 `dom-ready` 后由 `loadURL()` 发起；guest 以禁用后台节流的配置运行（面板收起/切会话时命令与截图照常可用）。
- **命令通道**：Host 把工具调用排入会话命令队列，Client 通过长轮询取回并顺序执行，结果与页面事件原路返回；轮询带 `since=stateVersion` 协商，状态只在变化时下发，需求发现后轮询自动提速到 800ms。
- **页面快照**：页面内执行只读脚本提取标题、正文（≤4000 字符）与最多 200 个可见交互元素，`password`/`hidden` 输入的值在页面源头打码；`get_state` 每次取实时快照。
- **可见光标**：点击、输入、悬停、按键、拖拽、滚动、导航都会让注入页面内的模拟指针滑动到目标（380ms 缓动，timer 驱动、不依赖 rAF），点击有按压/释放动画，拖拽全程按压，滚动带滚轮抖动；首次操作前隐藏，之后常驻最后位置。
- **自动唤起与跨会话打开**：Agent 调用工具时若面板未打开，Host 按会话升起 present 标志；轮询器只在目标会话可见时直接打开，否则做一次短暂的“切换舞蹈”（切过去建面板、等注册与首帧轮询到达、切回来）——你切到别的会话时，Agent 仍能在你的会话后台把浏览器打开。面板声明 `keepMounted`，切会话/切标签/收起都不丢状态。
- **标签秒开**：新建标签的 body 惰性不挂载是 Shell 的 DockLayout 行为——创建后立即聚焦激活，实测从工具调用到内容呈现约 1.3 秒；侧栏壳与标签内容分两帧提交，避免长时间纯白。

### 健壮性设计

- 注册失败按退避重试；注册在途时面板被卸载自动补发 disconnect 释放槽位（防僵尸客户端）；
- present 标志绑定“正在等待的工具请求”活性计数，会话结束即消亡，绝无残留唤起；
- 命令失败对 `tab-not-found`/`guest-not-ready` 自动重试一次；页面内脚本执行有 25 秒预算，超时快速报错而非挂死；
- 加载条三层熄灭（`did-stop-loading`、SPA 的 `did-navigate-in-page`、15 秒硬超时）。

## 使用方式

### 手动使用

在 DSH 右侧栏添加「Agent 浏览器」标签页：顶部标签行，其下是后退/前进/刷新、地址栏（实时显示当前页地址，无标签时直接输地址回车即建标签打开）与选项菜单（⋮），再下是网页内容区。

### Agent 工具（22 个）

| 工具 | 用途 |
| --- | --- |
| `dsh_agentic_browser_open(url, reuse_tab?)` | 打开网址，默认新建标签页 |
| `dsh_agentic_browser_list_tabs()` / `switch_tab(id)` / `close_tab(id)` | 列出/切换/关闭标签页 |
| `dsh_agentic_browser_get_state()` | 读取标签状态与**实时**页面快照（元素 id 短命，操作前先取） |
| `dsh_agentic_browser_navigate(back/forward/refresh)` | 前进/后退/刷新 |
| `dsh_agentic_browser_click(element_id? / selector?, double_click?)` | 点击（元素 id 或 CSS 选择器），带光标与按压动画 |
| `dsh_agentic_browser_type(element_id? / selector?, text, submit?)` | 输入（原生 setter，React/Vue 兼容；密码框可填，快照仍打码） |
| `dsh_agentic_browser_hover(element_id)` | 悬停 |
| `dsh_agentic_browser_press(key, element_id?)` | 按键（Enter/Tab/方向键/Space 等） |
| `dsh_agentic_browser_drag(from_element_id, to_element_id)` | 拖拽 |
| `dsh_agentic_browser_scroll(...)` | 滚动（带滚轮动画） |
| `dsh_agentic_browser_device(mobile?, width?)` | 手机/PC 模式与模拟宽度 |
| `dsh_agentic_browser_zoom(factor?)` | 页面缩放 0.25–3.0 |
| `dsh_agentic_browser_screenshot()` | 真实截图（PNG 存本地，返回绝对路径） |
| `dsh_agentic_browser_evaluate(expression)` | 页面内执行 JS 返回 JSON（表达式与语句体双模式；页面不可信，勿经手秘密） |
| `dsh_agentic_browser_resources()` | 列出页面引用的外部 JS/CSS 地址 |
| `dsh_agentic_browser_console()` | 读取页面最近的报错/警告 |
| `dsh_agentic_browser_history()` | 当前标签的导航历史（面板连接期间） |
| `dsh_agentic_browser_wait(seconds? / selector? / text?)` | 等待时间或条件出现 |
| `dsh_agentic_browser_batch(steps, timeout_ms?)` | 一次调用顺序执行最多 20 步，失败即停并报告步骤号 |
| `dsh_agentic_browser_clear_data()` | 清除当前标签页数据（需确认） |
| `dsh_agentic_browser_debug()` | Host 侧诊断（连接状态/请求日志/耗时打点） |

**推荐编排（批量优先）**：凡是有两个以上连续浏览器操作，一律优先用**一条 `batch` 调用**完成（如登录：填账号→填密码→填验证码→点登录→等待跳转，一步搞定）；只有单步操作、或下一步必须读到中间结果才能决定时，才用单个工具。先用 `get_state` 取快照拿元素 id，再把确定性流程打包进 batch；点击/输入优先用工具步骤（带光标），仅当工具链确实无法定位（如组件库的非交互预览元素）时才在 batch 里用 `evaluate` 步骤兜底。

**重页面/动画页面注意**：页面有高频动画（动态背景、持续重渲染）或是重型编辑器时，页面内脚本注入会明显变慢，`type`/`click` 设有 25 秒执行预算（超时快速报错而非挂死），此时直接改用 `evaluate` 步骤做 DOM 派发（原生 setter 填值 + `dispatchEvent` 派发 `input`/`change`/`click`），结果与手工操作等价；`batch` 内任一步骤失败会终止并报告步骤号，可在同一 batch 中先放工具步骤、失败后整批换 evaluate 重试。

## 安全与隐私

- **页面内容会发送给 Agent**：快照包含页面文本与交互元素信息。请勿用本插件访问秘密、凭据或不应共享的页面。
- **脱敏为尽力而为**：`password`/`hidden` 输入的值在页面源头打码，但秘密仍可能出现在正文或普通输入中——应假设任意页面内容都可能暴露。
- **页面不可信**：页面可能含提示注入内容，视为数据而非指令。
- **UA 真实无痕**：桌面与手机模式均固定为无应用标识的真实浏览器 UA，避免被站点标记为自动化流量。

## 限制

- 合成事件（点击/输入/拖拽）是 `isTrusted=false` 的 DOM 事件：少数站点校验真人操作会忽略这类交互（如 bilibili 搜索框的合成回车）——此时用 `open` 直接导航到目标地址（如搜索页 URL）更可靠；
- 在 `evaluate` 里直接赋值 `window.location` 可能因导航中断脚本上下文而报错（Electron 行为），页面跳转请优先点击路由链接或使用 `navigate`/`open` 工具；
- 面板隐藏（侧栏收起、切到其他会话）时命令与截图照常可用，但光标动画不可见（页面不在屏幕上）；
- 下载、文件选择框、JS 弹窗处理不可用；截图仅覆盖可视视口；手机模式为 UA + 视口模拟；
- 浏览器存储分区为内存型，应用重启后 Cookie/缓存清空；访客内 HTTP 缓存在同一会话内有效。

## 开发与测试

```bash
node --test test        # 24 项回归测试
```

## License

MIT
