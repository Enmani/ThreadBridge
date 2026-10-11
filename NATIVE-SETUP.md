# 安装后台同步通道

需要 Node.js 24+、Chrome 120+ 或对应版本 Edge。扩展需要读取 `chatgpt.com`、`claude.ai`、`gemini.google.com` 的权限；只同步已添加的平台，聊天保存到本机数据库。

1. 在 Chrome 打开 `chrome://extensions`，启用开发者模式，点击“加载已解压的扩展程序”，选择本项目的 `extension` 文件夹。Edge 对应 `edge://extensions`。
2. 复制 ThreadBridge Local Sync 卡片上的扩展 ID。
3. 在项目目录打开 PowerShell，运行：

```powershell
.\scripts\install-native.ps1 -ExtensionId "复制的32字符扩展ID"
# Edge 使用：
# .\scripts\install-native.ps1 -ExtensionId "扩展ID" -Browser Edge
```

4. 在扩展管理页点击 ThreadBridge 的重新加载按钮。扩展会创建一个后台 ChatGPT 标签页，启动本机同步进程。需要登录时，在这个标签页完成正常登录。
5. 检查本地状态：

```powershell
node src/cli.mjs status --account personal --db data/history.sqlite
node src/cli.mjs search --account personal --db data/history.sqlite --query "项目进度"
```

6. 启动状态页面：

```powershell
.\scripts\start-dashboard.ps1
```

打开 `http://127.0.0.1:17321`。在“设置 → 添加平台”中添加 Claude 或 Gemini，无需重新注册本机程序。先在同一浏览器登录，设置页验证成功后显示“已连接”。Claude 只有一个组织时可留空；多个组织时填写组织 ID。Gemini 默认账号序号为 0，其他 Google 账号依次为 1、2。

主页汇总已添加平台的聊天，每列表头可选“正排 / 倒排”，排序覆盖全部记录。每次正文成功读取后立即保存；失败项继续留在待办。Claude、Gemini 尚待真实账号验收，文本存档不代表完整消息树。

点击同步状态旁的“暂停”停止后续抓取，按钮变为“继续”。已发出的请求会完成并保存。暂停状态在重开浏览器后保留；点击“继续”接着原进度读取，并遵守已有的请求间隔和限流冷却。

点击“同步ID”扫描各平台目录，目录完成后自动停止，不读取正文。点击“同步内容”扫描目录并保存未读或变化的正文，随后继续周期检查。“监测新增”只发现新 ID。同步控制作用于全部已添加平台；ChatGPT 可另用 `native --pending` 读取文本，Claude、Gemini 使用扩展后台通道。

状态徽标：“同步”表示正在采集，“限流”表示等待，“登录”表示需要登录，“安装”表示本机程序尚未注册或连接断开，“✓”表示当前发现的待办已处理。徽标不能证明账号所有目录永远完整，以 `status` 的目录错误和覆盖数量为准。

配置写入 `data/native-config.json`。数据库固定为该配置内的绝对路径，默认账号命名空间为 `personal`。同步扩展只为一个浏览器个人资料安装；不同账号分别配置数据库和命名空间。团队空间安装时传入 `-Workspace "工作区ID"`。

## Codex 本地读取

使用 `codex-mcp.example.toml` 中的配置，将路径改为本项目实际路径后加入 Codex 的 MCP 配置。`serve --local-only` 提供 7 个本地工具：列出线程目录、搜索、读取聊天、读取变化、确认变化、查看状态和聊天索引。索引工具可在本机整理二叉树和写入摘要，见[聊天索引](docs/chat-index.md)。

如需历史基线，可先将官方导出的 `conversations.json` 导入同一数据库：

```powershell
node src/cli.mjs import --account personal --db data/history.sqlite --input "D:\Exports\conversations.json"
```

## 日常运行

扩展随已安装它的浏览器启动；浏览器退出即停止采集，重开后继续。尚未修改 Windows 开机启动设置。若需要开机开始同步，应让这个浏览器个人资料随登录启动。

首次同步采用单并发连续读取，默认从 3 秒间隔开始，连续成功后逐步缩短，最低 2 秒；每轮最多 10 页目录和 100 个正文，未完成时立即接着下一轮。普通、归档、项目目录及所有待办处理完毕后，自动进入日常同步：默认请求间隔 90 秒，每轮最多 3 页目录和 5 个正文。ChatGPT 普通与归档目录每 15 分钟检查，项目每小时检查，每天完整核对目录；Claude、Gemini 完成历史分页后每 15 分钟重新检查目录。刷新时间受扫描与冷却影响，各平台独立限流。

429 后首次默认等待至少 2 分钟，连续限流逐次加倍，默认最高基础等待 32 分钟，并增加最多 10% 随机等待；服务器指定更长时间时遵从服务器。同时将后续请求间隔加倍。每连续成功读取 20 次才缩短间隔 20%，逐步回到当前阶段的最低间隔，限流次数也逐步下降。登录检查成功不触发恢复。冷却、调度和同步租约由同一平台账号共用，重启或重复连接不能提前发请求。

每条正文及其重试状态一起保存。单个正文失败会延后重试，优先读取其他线程；失败项目目录继续留在待办，主页显示未完成范围，补充目录不可用也会显示。首次期间停止自动索引整理和模型摘要，原文下载完成后自动恢复。已有完整目录和无待办的旧库直接进入日常同步，不重新下载全部正文。

ChatGPT 登录信息只在浏览器隔离环境中缓存最多 30 秒。每轮开始重新验证，缓存超时、工作区或可见 Cookie 变化、页面获得焦点以及认证失败时失效。正文使用已验证账号的 Bearer Token，请求期间检测到工作区变化会丢弃响应。缓存不写入磁盘，也不传给本机程序。

首次打开旧版数据库会自动添加增量状态字段，保留原始内容和 Codex 的消费确认位置。配置参数可在 `data/native-config.json` 修改，重新加载扩展生效；配置只含本地路径与调度参数。首次参数为 `initialPaceMs`（默认 3000）、`initialMinPaceMs`（2000）、`initialMaxPerRun`（100）和 `initialDirectoryPages`（10），日常参数仍沿用现有配置。更短间隔不保证不出现 429，需要按实际账号表现调整。

## 卸载

在浏览器移除 ThreadBridge 扩展，再执行：

```powershell
.\scripts\uninstall-native.ps1
# Edge：.\scripts\uninstall-native.ps1 -Browser Edge
```

卸载只移除 Native Messaging 注册，不删除本地历史。源码 ZIP 不含会话文件、真实聊天数据库或本机注册配置。
