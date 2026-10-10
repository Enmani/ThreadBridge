# ThreadBridge

把 ChatGPT、Claude 和 Gemini 聊天保存到本机，供 Codex 或其他 MCP 客户端检索和读取。聊天内容、历史版本和同步进度保存在 SQLite，无需模型 API Key，也不用部署外部数据库。Claude 和 Gemini 接入仍待真实账号验收。

[English](README.md) · [详细用法](docs/usage.md) · [扩展安装](NATIVE-SETUP.md) · [运行与恢复](docs/operations.md)

## 能做什么

- 导入 ChatGPT 原始 JSON，保留消息分支和附件引用。
- 通过 Chrome/Edge 扩展同步线程目录与正文，或只监测新线程 ID。
- 在设置中逐个添加平台，登录验证后显示“已连接”。
- 浏览 ChatGPT 时保存页面已经加载的消息，并标明可能不完整的内容。
- 搜索本地聊天、读取历史版本、按消费游标处理变化。
- 在主页统一查看聊天，每列可选正排或倒排；说明收在悬浮气泡中。
- 查看进度、暂停与继续、导入 ChatGPT JSON。
- 通过命令行或本地 MCP 调用以上能力。

## 开始使用

需要 Node.js 24 或更新版本。在项目目录运行：

```sh
git clone https://github.com/Enmani/ThreadBridge.git
cd ThreadBridge
node src/cli.mjs import --account personal --input "你的导出目录/conversations.json"
node src/cli.mjs status --account personal
node src/cli.mjs search --account personal --query "项目进度"
node src/cli.mjs read --account personal --id "聊天 UUID"
```

默认数据库为当前工作目录下的 `data/history.sqlite`。跨目录调用时传入 `--db` 绝对路径，各入口使用相同数据库和 `--account`。命令行支持带 `mapping` 的原始 JSON；本地页面还支持指定格式的文本导出，保存时标记为 `export-text`。

运行 `npm run dashboard` 后打开 `http://127.0.0.1:17321`。Windows 可以运行 `scripts/start-dashboard.ps1`，在后台启动并沿用已有 Native Messaging 配置。

## 后台同步与 MCP

浏览器扩展安装见[安装说明](NATIVE-SETUP.md)。自带的 Native Messaging 注册脚本支持 Windows，默认添加 ChatGPT；在“设置 → 添加平台”中添加 Claude 和 Gemini。先在同一浏览器登录，验证成功才显示“已连接”。关闭浏览器会停止采集，重开后继续。

“同步ID”只读目录；“同步内容”读目录与正文；“监测新增”按周期发现新 ID，不读取正文。主页的同步控制作用于已添加平台，各平台独立保存进度与限流冷却。ChatGPT 浏览存档另有开关。

MCP 配置见 [codex-mcp.example.toml](codex-mcp.example.toml)，各平台分别配置本地读取入口。CLI 使用 `--provider chatgpt|claude|gemini` 选择读取的平台，默认 ChatGPT。

## 数据与范围

数据库和会话文件不应提交到仓库。浏览器同步会联系已添加的平台；Claude、Gemini 凭证留在浏览器内，ChatGPT 开发用令牌工具可能将登录会话保存为本地文件。

网页接口可能随网站更新失效。Claude、Gemini 保存接口返回的文本与原始数据，标为 `bounded-text`，完整分支覆盖尚未确认；Gemini 单聊达到 10,000 轮或返回续页信号时保留为待读取。不能恢复已删除或临时聊天，不下载附件文件。自动测试不证明账号历史已全部覆盖或长期同步稳定。

## 开发

```sh
npm ci
npm run precheck
```

检查覆盖 JavaScript 语法、模块行数和自动测试，使用合成数据，无需登录 ChatGPT。

[项目文档](docs/README.md) · [参与开发](CONTRIBUTING.md) · [当前任务](TODO.md) · [MIT 许可证](LICENSE)
