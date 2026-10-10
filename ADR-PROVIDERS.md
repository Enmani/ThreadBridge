# 多平台历史同步

ChatGPT、Claude、Gemini 使用同一个后台同步流程，各自保存目录位置、租约、待办、账号绑定、限流冷却与消费游标。Claude、Gemini 通过扩展中已登录的平台页面读取历史，凭证不传给本机进程。接口仅允许登录验证、目录和单聊读取；Gemini 的 POST RPC 只构造两种只读请求。

## 存储与覆盖

ChatGPT 沿用原账号键，不迁移既有历史。其他平台使用保留前缀 `@threadbridge/<provider>/<JSON account>`，外部账号名称禁止使用该前缀，避免聊天 ID、索引或游标相撞。共享数据库连接的视图共用事务深度；跨平台控制在同一事务中提交。

Claude 保存原始 `chat_messages` 与文本索引；Gemini 保存原始 RPC 数据和可识别的用户消息、候选回答。均标为 `bounded-text`，不宣称完整分支树。结构异常、重复页或游标、截断响应不确认完成；扫描游标与该页发现记录一起提交。有限文本更新不产生未返回消息的删除事件，不覆盖完整树。

Gemini 单聊请求最多 10,000 轮。达到窗口或存在续页信号时拒绝确认该聊天，保留待办。平台附件文件不下载。真实账号兼容性与全量覆盖待验收。

## 添加平台

设置页添加平台，不切换主页来源。默认只有 ChatGPT；已添加列表保存在 SQLite，后台程序每秒发现新增配置并启动对应 worker。重复添加返回 409，平台、组织 ID 与 Google 账号序号严格校验。

配置写入只代表已添加。worker 验证账号并保持有效心跳后，设置页才显示“已连接”。登录失败、账号变化和浏览器离线分别显示。暂停时添加平台可以验证登录，但不读取历史；继续不会绕过该平台限流冷却。

## 主页排序

主页只合并元数据，保留每行平台身份。排序使用固定字段白名单，在 SQL 分页前执行；聊天 ID 与账号作为稳定次序。每列提供正排和倒排；窄屏使用相同字段的选择框。搜索与排序变化丢弃旧请求结果，回到第一页。

## 接口参考

- [Claude 历史读取流程](https://github.com/egroup-labs/kept/blob/main/extension/api_process_flow.md)
- [Gemini 历史 RPC](https://github.com/HanaokaYuzu/Gemini-API/blob/master/src/gemini_webapi/components/chat_mixin.py)

网页内部接口不是官方稳定 API，结构变化时失败并保留进度。
