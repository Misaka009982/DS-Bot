# 服务器资源增补协议

本协议对应 DS-Bot 增补 1.1.0 及当前未发布补丁的服务端源码。能力由 `state.extras` 或 `extra-status` 返回；未声明的模块不可调用，不通过通用 Gateway 转发未知方法。Deck 已完成本地终端／文件面板接线，手机保留原清理入口；真实服务器验收仍待用户完成，既有发布构建不能证明后续补丁已安装。

## 能力和设备授权

- `extras.terminals: { schema: 1, read, write }`：真实 PTY 服务存在时声明，已有插件终端待清理时也保留入口。
- `extras.workspace: { schema: 1, read, write, readOnlyPreview?: true }`：公开 `fs` 与 `sessionQuery` 方法可用时声明；没有 `writeText` 时 `write` 为 false。`readOnlyPreview` 为后续补丁新增的可选声明，旧客户端省略读取标志仍保持原协议。
- `extras.toolChanges: { schema: 1, read }`：历史工具修改元数据读取，不读取当前文件。
- 缺模块、设备未授权、句柄失效和结果未知分别处理；能力检查不会创建进程、打开 Agent 或读取文件正文。

电脑设置 → 连接 → 手机中的每个配对设备增加 `terminalRead`、`terminalWrite`、`filesRead`、`filesWrite` 四项独立授权，默认全关。开启需确认；终端提示系统账号权限与原始输出的敏感性，文件编辑提示版本检查及外部并发隔离限制。服务暂时缺失时仍保留已授权限的撤销入口。

`phone-extra-set { deviceId, pairedAt, resources: { … } }` 只能在电脑调用。它用真实配对记录绑定公钥和配对时间，并生成新的资源授权代次；关闭读取会同时关闭相应写入。更改任意资源开关会使该设备全部旧资源句柄失效，重新开启也不能复用。授权写盘失败回退；落盘期间关闭资源访问。完整消息授权独立保存，不放开终端或当前文件访问。普通 Gateway 没有配对身份，不能取得资源权限。

历史 `extra-tool-change` 要求完整消息授权；它不授予当前文件读写。终端、文件和历史回包在异步步骤后重新核对身份、取消与归属。撤销会阻止新操作和未返回的正文，但不能撤回已经被服务器接收的终端输入或已经提交的文件原子写入；这类操作需要查询结果，客户端不得自动重发。

## 根会话与句柄

新建终端和打开工作区使用 `{ scope, sessionId }`：

| scope | 对应的真实归属 |
| --- | --- |
| `{ kind: 'bot', botId }` | Bot 的当前私聊 |
| `{ kind: 'room', roomId }` | 群的当前会话或当前成员会话 |
| `{ kind: 'task', botId, taskId }` | 该 Bot 后台任务的当前会话 |
| `{ kind: 'agent', agentId }` | 团队登记的 Agent 会话；浏览器配对仍拒绝 |

工作目录来自公开 Session 查询的 `workingDirectory` 投影、会话头或宿主工作目录默认值，不接受设备自报根路径。句柄以随机 ID 表示，绑定设备、公钥、配对时间、授权代次及会话归属，有效期 10 分钟；文件根还绑定工作目录和提供方对象。换段、归属／目录配置变化、重配、撤销、重启或卸载会使相应句柄失效，文件操作还会重读会话当前 cwd。用户终端有自己的 shell cwd，不随 Agent 在同一会话中执行 `cd` 自动搬迁。设备只发送相对文件路径；`targetKey` 是不透明标识，不拆解成路径。

## 用户终端

插件通过公开 `ctx.subprocess.spawnTerminal` 分配真实 PTY，由同一执行世界的文件服务解析 cwd；只启动提供方验证的交互 shell。插件不使用普通 pipe 进程冒充终端，不调用会争抢控制权的 `terminalController.attach`，不枚举或接管 Agent／DSH 现有工具终端。

用户终端是独立资源，以服务器系统账号权限运行。只读设备观察同一范围内的输出不改变输入权；写授权设备也只能控制自己创建的终端。电脑上的“服务器用户终端”管理行可按需列出全部插件用户终端并二次确认关闭，包括已移除设备遗留的终端。

| 端点 | 参数／返回要点 |
| --- | --- |
| `extra-terminal-list` | `{ scope, sessionId }` → `items`、输入／输出预算；只读，不创建进程 |
| `extra-terminal-list` | `{ owned: true }` → 当前设备拥有的清理目录；电脑可列出全部用户终端。`cleanupOnly: true` 句柄只可关闭，不能读正文、输入或 resize |
| `extra-terminal-create` | `{ scope, sessionId, requestId, cols, rows }` → `terminalId`、`handleId`、`expiresAt`、状态和控制序号 |
| `extra-terminal-read` | `{ handleId, offset }` → `data`（base64 原始 PTY 字节）、`from`、`nextOffset`、`throughOffset`、`truncated`、退出／输出状态、最近控制结果 |
| `extra-terminal-input` | `{ handleId, sequence, data }` → `accepted`／`pending`／`unknown`；`data` 为有效 Unicode 字符串，最大 16 KiB UTF-8 |
| `extra-terminal-resize` | `{ handleId, sequence, cols, rows }` → 同输入回执；列数 2–500，行数 1–200 |
| `extra-terminal-close` | `{ handleId }` → 仅在提供方 `terminate()`、剩余输出排空及 `done` 结算后确认 `closed`；失败为 `close-unknown` |

创建请求按设备身份和 `requestId` 去重；同一编号不同目标／尺寸被拒绝，已经关闭的请求不会重新创建。每次宿主生命周期最多保留 256 份创建回执，达到上限明确拒绝；关闭并重启由用户决定。最多保留 32 个未明确关闭的终端，每会话 8 个；自然退出仍保留输出和清理入口。

同一有效句柄的输入与 resize 共用连续 `sequence`，起点由服务端给出。仅重查同序号、同参数回执，不再次投递；旧序号、跳号、同序号不同参数被拒绝。一次控制结果不确定后，该终端禁止后续输入，不以更换句柄解除。设备应先查询状态，不自动重放输入、创建或 resize。

每个终端保留 512 KiB 环形输出，单次最多 32 KiB。游标为累计字节数，UTF-8 与 ANSI 序列可跨页；消费方要增量解码并使用受限终端渲染器，不赋予 OSC、链接或转义序列本机权限。缓存丢失明确报告 `truncated`，不伪造完整屏幕快照；需要重建完整屏幕的原 DSH 终端仍由原界面提供。

关闭面板／普通断线不结束已创建终端。换段后的旧操作句柄失效，可以用 `{ owned: true }` 取得新的仅关闭句柄；不能继续向旧目标投递输入。明确关闭后最多保留 10 分钟尾部输出，最多 32 个已关闭缓存。插件卸载会等待其创建中的分配与用户终端清理；清理失败不会报告成功。自动归档跳过仍保留的用户终端对应会话。

## 工作区文件

| 端点 | 参数／返回要点 |
| --- | --- |
| `extra-workspace-open` | `{ scope, sessionId }` → `rootId`、会话、过期时间、大小预算和写能力 |
| `extra-workspace-list` | `{ rootId, path, cursor? }` → 名称／类型／可用大小、`filtered`、下一游标；根路径用空串 |
| `extra-workspace-read` | `{ rootId, path, readOnly? }` → 完整 UTF-8 `text`、不透明 `version`、`redacted`、`editable`、可选 `receiptId`；已声明 `readOnlyPreview` 时可用 `readOnly:true` 预览而不领取编辑回执 |
| `extra-workspace-save` | `{ rootId, receiptId, requestId, content }` → 保存回执状态及成功时的新 `version` |
| `extra-workspace-save-status` | `{ rootId, receiptId }` → `ready`／`pending`／`saved`／`conflict`／`failed`／`unknown` |
| `extra-workspace-change` | `{ rootId, receiptId }` → `source: 'workspace-save'`、实际 `before`／`after`、`complete`、`redacted` |

最多同时保留 64 个根和 32 个编辑回执；模块限制 4 个并发请求。目录最多读取 4096 个条目，分页 64 个；目录摘要变化拒绝续页。文件只接受不超过 256 KiB、完整有效的 UTF-8、无 NUL 文本。超过预算、二进制、无效编码分别报错，不以截断预览开启编辑。

路径拒绝绝对路径、`..`、空段、反斜杠、UNC、URL、ADS、设备名和控制字符；拒绝符号链接／junction 及受保护目录、认证文件、密钥扩展名。逐级 `lstat`、规范化 `resolve` 与提供方 `contains` 验证真实目标，解析后仍检查敏感名称。DSH／Bot 数据目录不能作为远程浏览根；只允许登记团队工作区在数据树内的明确例外。跨执行世界的宿主路径映射由提供方负责，不能把本机路径当成 SSH 路径。

密钥库未就绪不传输文件正文；内容脱敏时只读且不发编辑回执。保存重新读取原文件，对比版本、完整内容摘要、根与保护规则，然后只调用带 `replaceIfVersion` 的公开 `writeText`，没有强制覆盖、创建／删除／移动入口。同一编辑回执只领取一次；后续相同请求仅查结果，不产生第二次写入。保存冲突保留客户端未保存的编辑内容，重新读取并比较后才取得新回执。

`writeText` 返回的真实新版本决定成功，异常结果按失败／冲突／未知区分。中途断线或撤销不意味着未保存。修改详情只使用后端成功回执的 `before`／`after`；旧基线缺失为 `null`，不冒充新建。脱敏服务稍后不可用也不会抹掉已确认的保存状态；无法安全展示的详情单独拒绝。回执到期、重启或目录变化后无法再确认，客户端保留“结果未知”，不能重新提交原编辑内容。

版本检查和规范化包含关系的能力边界仍见 [接线核对](resource-audit.md)：普通 `fs-local` 不提供跨所有外部进程的内核级 CAS，也不封闭恶意祖先链接替换的最后 TOCTOU 窗口。部署者必须按实际执行后端验收／隔离；本协议不宣称这些更强保证已经满足。

## 历史工具修改

`extra-tool-change { sessionId, callId, callSeq, index?, digest? }` 在明确归属与完整消息授权后，从原生 `tool/result.data.meta` 或 PTC `tool/ptc-dispatch.data.meta` 读取 `diffs`。只接受已确认成功的 `write`、`edit`、`apply_patch` 记录；PTC 的 `parentCallId`、`isError` 和 `content` 使用公开字段，旧格式只保留既有兼容读取。

每次返回一个真实 hunk：`schema: 1`、`source: 'tool-result'`、原会话／调用／调用序号／结果序号、`index`、`total`、`nextIndex`、`path`、`oldText`、`newText`、`oldAvailable`、`stopped`、`redacted`、`pathRedacted` 和摘要 `digest`。同编号再次调用也按原调用序号隔离结果。工具短列表同步按实际事件序号区分各次调用，结果只归给前一对应调用区间，隐藏调用仍形成边界；重复事件不增加条目。短说明只取真实参数的 `description`／`justification` 并脱敏，缺失不生成。

最多 256 个 hunk，单个 old／new 各 64 KiB；超过预算时明确该片段不可完整展示，保留下一索引。`stopped: true` 表示补丁仅有已记录的部分成功，不能渲染为整批完成。`oldText: null` 表示没有旧文本，不推断为新文件；元数据缺失、失败或未完成均不从参数、成功文案或当前文件补造 diff。路径只是当时的记录，打开当前文件仍须取得新的工作区根并重新验权，不能作为任意路径访问令牌。

所有文本返回前重新脱敏，密钥库锁定、撤销、取消与会话归属变化拒绝旧正文。历史修改与当前文件／本次远程保存的来源标签必须分别显示。
