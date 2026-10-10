# 运行与恢复

## 文件位置

默认数据库是工作目录下的 `data/history.sqlite`。Windows 原生安装将绝对数据库路径、账号和调度参数写入 `data/native-config.json`，并生成 `native-host.cmd` 与 `native-host.json`。后台页面进程 ID 保存为 `data/dashboard.pid`。

`data/`、数据库、会话文件和日志均被 Git 忽略。备份与导出同样包含私人信息，应放在源码目录外。

## 启动与停止

```sh
npm run dashboard
```

页面监听 `http://127.0.0.1:17321`，终端按 Ctrl+C 停止。其他账号或数据库使用：

```sh
node src/dashboard.mjs --account personal --db /absolute/path/history.sqlite --port 17321
```

Windows 后台启动使用 `scripts/start-dashboard.ps1`，读取已有原生配置。停止前确认 `data/dashboard.pid` 中的进程确实是本项目的 Node 页面服务，再结束该进程。

扩展随浏览器运行。关闭浏览器会停止后台采集；页面关闭不会停止采集。暂停按钮保存同步控制状态，已发出的请求仍可完成。浏览存档有单独开关，暂停同步不等于关闭浏览存档。

## 备份与恢复

1. 暂停同步，关闭安装扩展的浏览器并停止页面及其他 ThreadBridge 写入进程。
2. 一起复制数据库及存在的 `-wal`、`-shm` 文件，另行备份 `native-config.json`。不在程序写入期间仅复制主数据库文件。
3. 恢复到可写目录，保留文件相对名称。路径发生变化时修改配置中的 `db`，或传入新的 `--db`。
4. 使用同一账号运行 `node src/cli.mjs status --account personal --db /absolute/path/history.sqlite`，检查线程数量、覆盖范围和待办，再恢复采集。

配置和 Windows Native Messaging 注册包含绝对路径。移动项目后重新注册扩展主机，并确认恢复的配置指向正确数据库。

模型连接、摘要选择和调用统计保存在数据库，原始聊天不依赖摘要模型。备份前暂停摘要并停止页面服务。在非 Windows 系统，还需备份数据库旁的 `<数据库文件名>.model-key` 并保持权限 0600；更换数据库文件名时相应更名密钥文件。Windows 的密钥绑定当前系统用户，迁移到另一用户或机器后在设置中重新输入 API Key。本机兼容模型无需密钥时可直接重连。服务异常退出的摘要租约最多 90 秒到期，不删除数据库或额度统计来恢复。

## 更新

先备份数据库，再更新源码、运行 `npm ci` 与 `npm run precheck`，最后重新加载扩展。首次打开数据库会运行现有的添加字段和建表升级，保留档案与消费游标。回退时恢复旧源码；数据库升级若不能由旧代码读取，使用升级前的完整备份。

未完成目录、待办、暂停状态和限流冷却保存在数据库。重启后沿用这些状态，不能通过删除数据库解决同步错误。

[返回文档](README.md)
