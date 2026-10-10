# 安装后台同步通道

需要 Node.js 24+、Chrome 120+ 或对应版本 Edge，以及已登录 ChatGPT 的浏览器个人资料。安装将允许扩展读取 `chatgpt.com`，并将聊天保存到本机数据库。

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

打开 `http://127.0.0.1:17321`。页面显示最近请求、最近保存、下次请求时间，以及可搜索的全部线程表格。每次正文成功读取后立即保存；读取失败的线程继续留在待办。

点击同步状态旁的“暂停”停止后续抓取，按钮变为“继续”。已发出的请求会完成并保存。暂停状态在重开浏览器后保留；点击“继续”接着原进度读取，并遵守已有的请求间隔和限流冷却。

点击“同步线程 ID”完整扫描目录，所有目录完成后自动停止，不读取正文。点击“同步全部内容”扫描目录并保存未读或变化的正文，随后按原周期继续检查。两个模式共用全部线程表格；ID 模式完成后，可在 Codex 中运行 `native --pending` 把文本内容写入同一个数据库，命令见 README。

状态徽标：“同步”表示正在采集，“限流”表示等待，“登录”表示需要登录，“安装”表示本机程序尚未注册或连接断开，“✓”表示当前发现的待办已处理。徽标不能证明账号所有目录永远完整，以 `status` 的目录错误和覆盖数量为准。

配置写入 `data/native-config.json`。数据库固定为该配置内的绝对路径，默认账号命名空间为 `personal`。同步扩展只为一个浏览器个人资料安装；不同账号分别配置数据库和命名空间。团队空间安装时传入 `-Workspace "工作区ID"`。

## Codex 本地读取

使用 `codex-mcp.example.toml` 中的配置，将路径改为本项目实际路径后加入 Codex 的 MCP 配置。`serve --local-only` 提供 6 个本地工具：列出线程目录、搜索、读取聊天、读取变化、确认变化和查看状态。

如需历史基线，可先将官方导出的 `conversations.json` 导入同一数据库：

```powershell
node src/cli.mjs import --account personal --db data/history.sqlite --input "D:\Exports\conversations.json"
```

## 日常运行

扩展随已安装它的浏览器启动；浏览器退出即停止采集，重开后继续。尚未修改 Windows 开机启动设置。若需要开机开始同步，应让这个浏览器个人资料随登录启动。

默认普通与归档目录每 15 分钟检查，已知项目每小时检查，每天完整核对目录。单并发、请求间隔 90 秒；每批最多 3 页目录和 5 个详情，未完成时继续。刷新时间会受扫描与冷却影响。

429 后首次默认等待 2 分钟，连续限流逐次加倍，默认最高 32 分钟；服务器指定更长时间时遵从服务器。同时将后续请求间隔加倍。下一次历史目录或正文请求成功后，立即恢复基础间隔（默认 90 秒），清零连续限流次数；登录检查成功不触发恢复。数据库保存页码、线程 ID、消息位置、待办及冷却时间，重开浏览器继续读取。`status` 中每个目录的下一页位置和停止原因可用于查看筛选进度。

首次打开旧版数据库会自动添加增量状态字段，保留原始内容和 Codex 的消费确认位置。配置参数可在 `data/native-config.json` 修改，重启扩展生效；配置只含本地路径与调度参数。

## 卸载

在浏览器移除 ThreadBridge 扩展，再执行：

```powershell
.\scripts\uninstall-native.ps1
# Edge：.\scripts\uninstall-native.ps1 -Browser Edge
```

卸载只移除 Native Messaging 注册，不删除本地历史。源码 ZIP 不含会话文件、真实聊天数据库或本机注册配置。
