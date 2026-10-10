# ThreadBridge 详细用法

把 ChatGPT、Claude、Gemini 聊天保存到本机 SQLite，供 Codex 通过命令行或 MCP 检索、读取和消费变化。需要 Node.js 24 或更新版本，无第三方运行依赖，无需模型 API Key。

推荐后台通道：专用浏览器扩展通过 Chrome 官方 Native Messaging 直接连接本机进程，逐聊写入 SQLite。扩展随浏览器启动，Codex 只访问本机数据库。安装见 [扩展安装](../NATIVE-SETUP.md)；选择依据和恢复机制见 [同步通道](../SYNC-CHANNEL.md)。

## 功能来源

| 项目 | 本版组合的功能 |
| --- | --- |
| [chatgpt-sync](https://github.com/pavel-voronin/chatgpt-sync) | 已登录浏览器 CDP 接入、更新时间水位、1 小时重叠扫描 |
| [export-chatgpt](https://github.com/brianjlacy/export-chatgpt) | 普通与归档聊天分页、项目目录与项目聊天分页、原始 JSON 保存 |
| [GPT2Claude-Migration-Kit](https://github.com/Siamsnus/GPT2Claude-Migration-Kit) | 多入口发现项目、10 个聊天批量读取、异常批次回退到单聊读取 |

ChatGPT 原始消息树、备用分支及分支后续消息均保存。附件引用与非文本消息结构留在原始 JSON 中；本版不下载附件文件。

SQLite 保存已发现聊天、同步状态、历史版本、消息索引、变化记录和每个消费者的确认游标。不需要部署外部数据库。

## 本地状态页面

在项目目录运行：

```powershell
.\scripts\start-dashboard.ps1
```

打开 `http://127.0.0.1:17321`，查看最近请求、最近成功保存、下次请求时间与倒计时，以及全部线程表格。表格可搜索标题或 ID，每列表头提供正排与倒排，排序覆盖全部记录。页面每 5 秒刷新本地状态，不会增加平台历史请求。说明可通过悬停、聚焦或点击气泡查看。

“设置 → 添加平台”逐个连接 Claude、Gemini，不切换主页来源。先在同一浏览器登录；Claude 多组织时填写组织 ID，Gemini 多账号时填写账号序号。登录验证成功才显示“已连接”。各平台独立保存待办、限流和消费游标；主页的同步控制作用于全部已添加平台。

同步状态右侧提供“暂停 / 继续”。暂停后保留进度，重开浏览器也保持暂停；已经发出的请求会完成并保存。继续时接着原进度读取，并遵守原请求间隔和限流冷却。

“同步ID”自动完整扫描普通、归档和可发现的项目目录，只保存 ID、标题、更新时间；所有目录完成后自动停止，不读取正文。“同步内容”扫描目录并读取未保存或变化的正文，完成当前待办后继续周期增量同步。两个模式共用表格、数据库和暂停按钮；切换模式保留原档案与未完成的完整目录位置，遵守已有请求间隔和限流冷却。完成一轮 ID 扫描后，再次点击 ID 按钮会开始新一轮完整目录检查。

开启“监测新增”保持低频目录检查：普通与归档目录默认每 15 分钟检查，已知项目每小时检查，每天完整核对目录，以发现时间异常的新 ID。只把数据库中没有的线程加入表格；旧线程回复变化不重新抓取，正文请求始终为零。扫描与限流可能延长检查周期。暂停后不检查，关闭开关会停止监测；选择全文模式关闭此开关。

“所属项目”显示项目名称，未知名称时显示项目 ID，无项目归属显示“—”。项目 ID 与名称也通过 CLI `threads` 和 MCP `list_threads` 返回，供 Codex 按项目筛选读取。名称保存在同一账号数据库的元数据中，目录返回项目名称或改名时更新，已保存线程无需重新读取正文。

启动脚本在后台运行页面服务；不存在数据库时创建空库。联网采集由已安装的浏览器扩展运行；连接方法见 [扩展安装](../NATIVE-SETUP.md)。关闭页面不会停止采集；关闭浏览器停止采集，重开续读。页面会根据同步进程心跳显示连接是否仍在。

数据库默认 `data/history.sqlite`，页面端口默认 17321，只监听本机。启动时已有 `data/native-config.json` 则沿用其数据库和账号。修改账号或数据库后，需先结束旧页面服务，再重新启动。

## 立即使用

在本目录打开 PowerShell。Windows 可以用 `threadbridge.cmd` 代替 `node src/cli.mjs`。

```powershell
npm run precheck
node src/cli.mjs import --account personal --input "D:\Exports\conversations.json"
node src/cli.mjs status --account personal
node src/cli.mjs search --account personal --query "项目进度"
node src/cli.mjs read --account personal --id "聊天 UUID"
```

`import` 接受官方导出的 `conversations.json`、原始单聊 JSON，或包含这些 JSON 的目录。缺少 `mapping` 的整理版导出会报错。导入部分失败时，成功项保留，退出码为 2，错误项列出。

默认数据库为当前工作目录下 `data/history.sqlite`。跨目录调用或定时任务请显式传入 `--db` 绝对路径；所有调用使用同一个 `--account` 和数据库路径。不同登录账号、个人空间和团队空间分别使用命名空间。

## Claude 与 Gemini

这两个平台使用浏览器扩展后台读取历史，不使用模型生成 API。Claude 分页组织内目录；Gemini 分别读取置顶与普通目录。目录和正文分批保存，失败页与待读取项在重开浏览器后继续。历史目录完成后默认每 15 分钟复查，正文更新时间变化或每日抽查时进入待办。

存档包含接口返回的原始数据与文本索引，覆盖标为 `bounded-text`，完整分支覆盖尚未确认。Gemini 单聊达到 10,000 轮或返回续页信号时拒绝确认完成。真实账号兼容性和长期覆盖待验收。

命令行默认读取 ChatGPT；其他平台加 `--provider`，例如：

```sh
node src/cli.mjs threads --provider claude --account personal --sort title --order asc
node src/cli.mjs search --provider gemini --account personal --query "项目进度"
node src/cli.mjs serve --provider claude --local-only --account personal
```

MCP 每个平台分别配置；原始 ChatGPT JSON 导入、CDP、直接 HTTP 和 Codex 原生读取仅用于 ChatGPT。

## ChatGPT 在线全量与增量同步

日常同步使用 `extension/` 与 `scripts/install-native.ps1`。默认单并发、90 秒请求间隔；普通与归档目录每 15 分钟检查，已知项目每小时检查，每天完整核对目录。每批最多扫描 3 页目录、读取 5 个详情，随后继续未完成的进度。无需手工保存令牌或调试端口。

线程按唯一 ID 更新原记录。目录中的更新时间或最新助手回复时间变化，就加入待办；待读取项按两者较新的时间从新到旧读取。保存最后消息 ID、最后助手消息 ID 和成功读取时间；消息 ID 重复时仍检查内容，保留同 ID 的编辑。SQLite 保存这些状态，不需要外部数据库。

普通与归档目录使用 `order=updated`，扫描范围与上次扫描重叠 1 小时。只有已观察页面保持时间降序、且整页都早于范围边界，才提前停止；碰到一条已存线程或重复消息不会停止。项目目录读取到游标末尾。缺少时间、排序异常和每日核对使用完整目录扫描。

`status` 返回已扫描页数、每个目录下一页位置、时间边界、停止原因、剩余目录及详情待办。分页游标、请求间隔和限流冷却都会落盘；重启从保存的位置继续。长时间历史扫描期间仍定期检查普通与归档目录头部。状态字段见 [同步通道](../SYNC-CHANNEL.md)。

刷新间隔是调度目标；扫描、请求间隔和服务端冷却会延长实际等待。90 秒是保守起点，不保证不会限流。每天最多抽查一个超过 7 天未读的聊天，补查时间字段未变化的正文编辑；需要全面复查正文时使用 `--refresh`。

下列会话捕获、CDP 和直接 HTTP 方式为开发与备用接入。

### 自动保存登录会话

浏览器已登录 ChatGPT 后，可以让 Codex 执行 `scripts/capture-authsession.codex.js`。先将脚本开头的 `root` 改为项目绝对路径；需要已连接的 Chat On Steroids Desktop 插件。脚本自动打开一个标签页、读取当前会话的 `accessToken`、保存为 `data/authsession.json`，然后关闭这个标签页。此脚本通过 Codex 工具运行，不能直接用 Node 运行。

文件仅包含 `accessToken`。凭证在浏览器内加密后传回本机写入，日志不输出原始凭证；临时传输文件与密钥在结束时清理。保存会话本身不运行聊天同步。

`authsession.json` 保存在本机 `data/`，不进入源码压缩包。登录过期后重新执行捕获脚本即可。

### 浏览器或令牌接入

提供一个**已经启用 CDP、已经登录 ChatGPT 且打开 ChatGPT 标签页**的本机浏览器地址：

```powershell
$env:CHATGPT_CDP_URL = "http://127.0.0.1:9333"
node src/cli.mjs sync --account personal --full
node src/cli.mjs sync --account personal
```

也可以通过当前进程环境变量 `CHATGPT_BEARER_TOKEN` 提供自己的会话访问令牌。CDP 方式自动从登录会话读取令牌，仅留在内存。团队空间可设置 `CHATGPT_ACCOUNT_ID`；该值是远端工作区 ID，与本地 `--account` 名称不同。账号切换时，CDP 模式会拒绝复用此前绑定的本地命名空间。

首次运行完整扫描普通、归档和项目目录；后续只读取新聊天、时间字段变化的聊天和未完成项。后台项目检查按小时调度；下列手动命令每次检查项目列表。每 24 小时完整扫描目录一次。项目发现入口包括侧栏、聊天元数据、两个可选项目索引、已保存 ID 和 `--projects g-p-ID1,g-p-ID2`。

```powershell
# 完整核对目录，只获取新增或更新时间变化的内容
node src/cli.mjs sync --account personal --full
# 完整目录并重新读取所有详情；用于检查没有更新时间变化的旧消息
node src/cli.mjs sync --account personal --refresh
# 可选加速：每批最多 10 个，发现结构异常后回退到单聊
node src/cli.mjs sync --account personal --batch --concurrency 3
```

默认使用单聊接口、1 个并发、90 秒请求间隔。首次 429 或 401/403 即暂停，未完成项保留；部分 5xx 最多重试 3 次。`--concurrency` 范围 1–8；`--max` 可限制本轮详情数量。后台扩展额外保存冷却截止时间：首次至少等待 2 分钟，再次限流按 4、8、16、32 分钟等待，默认最高 32 分钟；服务器要求更久时遵从 `Retry-After`。后续请求间隔另行加倍，最高 1 小时；下一次历史目录或正文请求成功后立即恢复基础间隔（默认 90 秒），清零连续限流次数。登录检查成功不触发恢复。备用手动命令不管理后台冷却，请勿在限流期间另开同步。

`--batch` 是可选实验加速。显式截断、缺失节点、错误 ID、循环树和相较上次缩小的批次会回退；如果服务端给出自洽但缺失整段分支的树，单靠结构无法识别，因此不能保证批量结果完整。需要可靠核对时，关闭批量并运行 `--refresh`。

退出码：0 为成功；1 为配置或运行错误；2 为同步/导入部分失败或仍有待读取项。失败不会确认消费游标；目录扫描失败不会推进扫描水位。

## Codex 定时任务读取变化

后台扩展负责联网同步。Codex 定时任务只读取同一个本地数据库的变化：

```powershell
node src/cli.mjs changes --account personal --db "C:\路径\history.sqlite" --consumer codex-daily --limit 100
```

`changes` 返回 `items` 和 `through`。任务成功处理这批变化后，才确认该值：

```powershell
node src/cli.mjs ack --account personal --db "C:\路径\history.sqlite" --consumer codex-daily --through 123
```

第一次消费会读到所有已存消息的 `added` 事件，相当于历史内容；之后读取新增、修改、消息移除及聊天元数据变化。读取后没有确认，下次仍返回同批内容。输出或写入动作应以事件 `seq` 去重。同一个消费者使用一个执行任务；其他用途换消费者名称。

确认游标只承诺“可重新读取”，无法和外部应用写入组成跨系统事务。已从远端删除的聊天保留本地历史，不自动判定整聊删除。此项目提供定时任务可调用的接口，未创建新的 Codex 定时任务。

## MCP 接入

参考 [codex-mcp.example.toml](../codex-mcp.example.toml)，修改绝对路径与本地账号名称后加入 Codex MCP 配置。本版只提供本地 stdio 接口，不开放网络服务。

推荐配置使用 `serve --local-only`，提供 6 个本地工具：`list_threads`、`search_history`、`fetch_threads`、`get_changes`、`ack_changes`、`get_sync_status`。`list_threads` 分页返回目录 ID、更新时间和存档状态，不联网读取正文。不启用本地模式时，另提供 `sync_history` 供备用通道使用。

## 原生 Codex 通道

在 Codex 提供 `CODEX_APP_TOOLS_PIPE_PATH` 的环境中，给出当前调用聊天 ID 和需要读取的 GPT 聊天 ID：

```powershell
node src/cli.mjs native --account native-personal --db data/live-native.sqlite `
  --caller "当前 Codex 聊天 UUID" --ids "GPT 聊天 UUID1,GPT 聊天 UUID2"
```

命名管道直接调用应用的 `read_thread`，默认单并发，并按游标读取较早页面。此接口每条文本最多 20,000 字符，缺少网页原始分支树，因此记录标记为 `bounded-text`。原生读取不能覆盖已存的 `full-tree` 记录；分页未完成时不会确认同步成功。只有目录接口或原始导入可以取得原始树。

ID 模式完成后，在 Codex 的本地执行环境运行以下命令，使用与页面相同的数据库和账号：

```powershell
# 本地分页目录，不请求远端正文
node src/cli.mjs threads --account personal --page 1 --limit 50
# 从已发现目录选取最多 5 个未存文本或版本变化的线程，读取后写回同一表格
node src/cli.mjs native --account personal --pending --max 5 --concurrency 1
```

跨目录使用时加 `--db` 绝对路径。当前 Codex 聊天 ID 默认从 `CODEX_THREAD_ID` 读取，也可指定 `--caller`。`--pending` 和 `--ids` 二选一；已存完整树不进入原生待办，文本版本未变化时不会重复读取。浏览器全文同步与原生写入共用账号租约，避免并发写入。遇到明确 429 时停止当前批次，失败项保留。该入口没有另建定时任务，也不承诺内部接口没有限流或能返回全部附件、分支。

## 范围与验证

`full-tree` 表示通过结构校验的原始消息树，不能证明远端没有省略数据。网页接口未经官方承诺，可能变化。仅同步当前账号、当前所选工作区内接口可访问的持久化聊天；不恢复已删除或临时聊天，不抓取其他人的分享链接。

运行 `npm ci` 和 `npm run precheck` 检查分页、分支、增量、事务、账号隔离、MCP、Native Messaging、目录模式、限流与恢复等行为。测试使用合成数据；真实账号全量覆盖和长期同步稳定性尚未建立。

项目结构：`transport` 负责访问，`discovery` 负责发现，`model` 校验树，`sync` 编排，`store` 保存与游标，`native` 接入应用原生管道，`cli`/`mcp` 提供调用入口。数据库采用 WAL、按账号隔离和单账号同步租约；每个消息树及变化记录一起事务提交。三方许可见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。

[返回文档](README.md)
