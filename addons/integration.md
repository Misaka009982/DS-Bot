# 增补接入与上游同步

## 固定基线

- 正式版本：`0.3.10`。
- 完整提交：`d104d9ca18d69a35460f14e15dff4d553181433a`。
- 增补版本／发布 tag／包版本：统一由 `manifest.json` 记录，禁止猜测最新版。
- 不改任何依赖锁文件、DSH 安装文件或用户的 `.dsh` 数据。

## 独立模块

| 目录／文件 | 职责 |
| --- | --- |
| `ds-bot/src/host/extras/settings.js`、`prompt.js` | 模式校验和每次用户输入的异步模式上下文 |
| `ds-bot/src/host/extras/write-settings.js`、`access.js` | 串行设置保存、失败回退与设备消息授权 |
| `ds-bot/src/host/extras/new-session.js`、`ds-bot/src/client/extras/new-session.js` | Manage 中确认新建干净私聊；保留 Bot 设置／记忆和旧历史，复用原切段交接及恢复 |
| `ds-bot/src/host/extras/archive.js` | 24 小时归档候选、保护规则、公开归档接口和冷历史读取 |
| `ds-bot/src/host/extras/log-page.js`、`tools.js` | 所有权检查、日志分页、PTC 子调用和工具详情 |
| `ds-bot/src/host/extras/messages.js`、`todos.js` | 内部消息、失败／重试状态与真实工具待办 |
| `ds-bot/src/shared/extras/` | 纯文本脱敏与增补文案 |
| `ds-bot/src/client/extras/` | 电脑设置、设备授权、折叠工具与消息读取适配 |
| `mobile/src/extras/` | 手机安全开关、工具详情、待办与后台任务阅读 |
| `link/src/extras/device-name.ts` | 已认证设备名称清理／刷新，不参与权限判断 |
| `addons/` | 固定版本、接入检查、打包与用户验收文档 |
| `.github/workflows/release-addons.yml` | 原版／增补独立验证，npm pack 后上传 Releases |

现有源码的变更集中在 `manifest.json` 的 26 个固定接入文件；测试和发布门禁另行列出。不能只复制 `extras/` 而遗漏这些接入点。

## 原文件接入点

| 文件 | 必要接入 |
| --- | --- |
| `ds-bot/index.js` | 安装一个 `extras` 模块，保留上游模块顺序 |
| `host/turns.js` | 在上游已有的 prompt 适配处传入新请求模式，不修改 DSH |
| `host/bot-tasks.js` | 显式 queue／steer 输入不转成新的后台任务 |
| `host/channel.js` | 增补状态、端点分发、已认证调用上下文、传递 send.mode |
| `host/phone.js` | 从真实配对记录验权、给每个远程状态注明消息授权、设备列表显示授权 |
| `host/remote.js` | Gateway 不得冒充已配对设备，不得修改电脑授权 |
| `host/parts.js` | 可选增强投影／工具字段、旧段冷读取；新建会话只替换上下文准备，复用原切段锁／转交／恢复；默认旧格式不变 |
| `host/mobile.js` | 群聊增强投影和旧群段冷读取 |
| `host/feed.js` | 稳定命名原 SSE 会话事件回调供测试定位，不新增监听器、不改变消息发布或权限 |
| `shared/browser-endpoints.js` | 只新增明确的增补端点，原敏感接口不放开 |
| `client/bot-settings.js`、`phone-page.js` | 额外卡片／设备授权与名称显示，Manage 插入新建会话行 |
| `client/team-actions.js` | 设置方法、携带当前 Session 的新建请求与后台任务增强读取 |
| `client/index.js`、`app/ui/src/team.js` | 合并增补 live 字段 |
| `client/cells.js`、`bot-tasks.js` | 复用增补工具摘要和纯文本消息组件 |
| `app/ui/src/chat.js` | 读取增强页、合并刷新，未知旧接口才回退 |
| `mobile/src/connection.ts` | 只增可选字段，不破坏原状态契约 |
| `mobile/src/team/link.ts`、`gate.ts` | 发送前手机门禁、增强读取、撤销时拒绝旧回包 |
| `mobile/src/screens/Settings.tsx`、`manage.tsx` | 一处设置组件插入 |
| `mobile/src/screens/Chat.tsx`、`chat/items.tsx` | 一处任务入口、工具／状态行及授权缓存隔离 |
| `link/src/pairing.ts` | 原公钥匹配后才刷新名称，保留类别与配对时间 |

`manifest.json` 的 `anchor` 保留原接入检查；同一文件的新增接入由可选 `anchors` 逐项验证。新建会话还需语义核对 `runMaintenance`、`startSwitch` 的错误／恢复流程、`save({ required: true })` 的所有权索引、模型／权限应用和 `moveSchedules`；不能仅凭锚点存在断言兼容。

`extra-*` 是新增协议，不把 `job_output` 名称、普通聊天文字或“未确认”当作完整工具结果。增强字段仅增强客户端使用，原 `chat`／`steps:true` 等旧调用保留原格式。

## 升级顺序

1. 用户明确选定下一份正式 Release，记录 tag 与完整提交。
2. 在独立干净目录验证原版插件、link、手机与桌面构建；不要先带入增补。
3. 比较 26 个接入文件的语义，尤其 prompt、inbox、归档／卸载、配对、错误事件、PTC 与分页契约。锚点文本相同也不代表语义兼容。
4. 只移植独立目录和逐个固定接入点。未知协议／任务状态应失败或跳过，不静默猜测。
5. 更新 `manifest.json`、检查脚本、固定测试及 release workflow 中原版 checkout 的 SHA；重新编号增补／包版本。
6. 重新生成 `client.js`／`link.js`／`office.js`，运行双方独立验证。若原版失败，优先定位上游／环境；原版成功而增补失败，再定位增补。
7. 用新 tag 发布 npm `.tgz` 和校验信息，先在数据副本验收，再用于正式数据。

## 回滚

退出全部使用同一数据的 DS Bot 宿主。保留增补源码和数据备份，不重置用户 Git 工作区、不删会话日志。重新安装原版正式包；`extras` 字段是增补字段，但不应依赖原版永久保留未知字段，重要授权和设置请备份。再次使用增补版时逐设备重新核对授权，不要仅凭名称恢复权限。

生成文件未在本机更新；当前源码本身不是已验收的可安装二进制。正式交付以 CI／用户成功构建并验证的安装包为准。
