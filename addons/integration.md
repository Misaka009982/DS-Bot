# 增补接入与上游同步

## 固定基线

- 正式版本：`0.4.0`（`Fei-Craft/DS-Bot`）。
- 完整提交：`7963e66a74f40d23daa288a76cdca72b34e39561`。
- 增补版本／发布 tag／包版本：统一由 `manifest.json` 记录，禁止猜测最新版。
- 依赖锁文件沿用选定的上游正式提交，不修改 DSH 安装文件或用户的 `.dsh` 数据。

## 上游功能优先

相似功能优先使用上游实现；与用户已确认需求不一致时，只保留必要的增补差异，不用旧补丁覆盖上游新机制。

| 功能 | v0.4.0 的处理 |
| --- | --- |
| 主 Bot 管理工具 | 采用上游宿主级工具／提示词过滤及会话隔离；旧版逐 Agent 监听器补丁不再保留。增补只登记 `pause_bot`／`new_bot_session`，并在叫停时暂停私聊目标 |
| Bot 协作、群目标、隐藏工作 | `bot-tasks.js`、`groups.js`、`goals.js`、`steer.js` 和 `agent-commands.js` 沿用上游；不接入旧 `extraKeepForeground` 例外，隐藏协作继续按上游隔离 |
| 目标与新建会话 | 上游仍只支持群目标、普通换段保留上下文；保留用户要求的仅有效 `steer` 私聊目标和显式干净新建入口，复用上游切段锁、转交及恢复，并保留 `agentPreset` |
| 聊天与工具 | 保留上游桌面 Session 分页、订阅、输入框与专用卡片；普通工具继续按用户要求默认收成一条总数、单项标题、命令与输出三层。群聊增补订阅与上游一样只在群聊且有 feed 时启用 |
| 聊天附件 | 桌面保留上游 `stage-file`／`send`；远程增补只补分片、配对设备归属和提交状态查询，最终发送继续复用上游 `sendUser` 与 DSH `fileUploads` |
| 工作区、终端及委派 | 上游桌面实现保持原样；其 `workspace-*`／`terminal-*`／`session-*` 是本机端点。远程继续使用增补协议、真实父子归属、受限根和逐设备读写授权，不放开上游本机端点 |
| 学习提案 | 复用上游提案内容、结算与批准／拒绝入口；保留用户要求的独立设备开关，并在执行前重新校验授权 |

## 独立模块

| 目录／文件 | 职责 |
| --- | --- |
| `ds-bot/src/host/extras/settings.js`、`prompt.js` | 模式校验和每次用户输入的异步模式上下文 |
| `ds-bot/src/host/extras/write-settings.js`、`access.js` | 串行设置保存、失败回退与设备消息授权 |
| `ds-bot/src/host/extras/new-session.js`、`ds-bot/src/client/extras/new-session.js` | Manage 中确认新建干净私聊；保留 Bot 设置／记忆和旧历史，复用原切段交接及恢复 |
| `ds-bot/src/host/extras/session-tools.js` | 仅主 Bot 使用的模型暂停与回执绑定的新建会话；执行时重验权，默认保留排队输入，拒绝未完成的旧私聊交接 |
| `ds-bot/src/host/extras/private-goal.js`、`ds-bot/src/client/extras/private-goal.js` | 用户显式启动的私聊持久目标、完成／阻塞记录、空闲续跑与停止保护；协议见 [private-goal.md](private-goal.md) |
| `ds-bot/src/host/extras/archive.js` | 24 小时归档候选、保护规则、公开归档接口和冷历史读取 |
| `ds-bot/src/host/extras/log-page.js`、`tools.js` | 所有权检查、固定真实 throughSeq 的日志分页、PTC 子调用和工具详情；截止序号只取现有 Agent 或非激活投影 |
| `ds-bot/src/host/extras/messages.js`、`todos.js` | 内部消息、失败／重试状态与真实工具待办 |
| `ds-bot/src/host/extras/delegations.js` | 基于 DSH 持久父子目录、实际子会话与结算事件的只读委派；协议见 [delegations.md](delegations.md) |
| `ds-bot/src/host/extras/resources.js`、`terminals.js`、`workspace.js`、`tool-changes.js` | 设备资源授权／短期句柄、真实用户 PTY、受限文件与实际修改记录；协议见 [resources.md](resources.md) |
| `ds-bot/src/shared/extras/` | 纯文本脱敏、增补文案与服务器配对名称校验／二维码元数据更新 |
| `ds-bot/src/client/extras/` | 电脑设置、设备授权、折叠工具与消息读取适配 |
| `mobile/src/extras/` | 手机安全开关、工具详情、待办与后台任务阅读 |
| `link/src/extras/device-name.ts` | 已认证设备名称清理／刷新，不参与权限判断 |
| `addons/` | 固定版本、接入检查、打包与用户验收文档 |
| `.github/workflows/release-addons.yml` | 原版／增补独立验证，npm pack 后上传 Releases |

现有源码的变更集中在 `manifest.json` 的 36 个固定接入文件；测试和发布门禁另行列出。不能只复制 `extras/` 而遗漏这些接入点。

## 原文件接入点

| 文件 | 必要接入 |
| --- | --- |
| `ds-bot/index.js` | 安装一个 `extras` 模块，保留上游模块顺序 |
| `host/turns.js` | 在上游已有的 prompt 适配处传入新请求模式；结算后通知私聊目标，停止入口冻结后续目标续跑；阻塞绑定失败会话／轮次／事件，同来源后续成功才清理并记录 recovery，不修改 DSH |
| `host/channel.js` | 增补状态、端点分发、已认证调用上下文、传递 send.mode |
| `host/phone.js` | 从真实配对记录验权，传递消息／资源授权上下文，设备列表显示独立读写授权；`phone-set.serverName` 保存服务器扫码名称，二维码与浏览器链接只变显示名，原身份／授权不变 |
| `host/remote.js` | Gateway 不得冒充已配对设备，不得修改电脑授权 |
| `host/parts.js` | 可选增强投影／工具字段、旧段冷读取；新建会话只替换上下文准备，复用原切段锁／转交／恢复；现有 pre-step 拒绝失效的私聊目标续跑，正常用户输入保持原行为 |
| `host/mobile.js` | 群聊增强投影和旧群段冷读取 |
| `host/feed.js` | 稳定命名原 SSE 会话事件回调供测试定位，不新增监听器、不改变消息发布或权限 |
| `host/constants.js`、`host/builtin-packs.js` | 登记 `pause_bot`／`new_bot_session` 并纳入原 `team-admin` 包；普通 Bot 默认不可见，执行仍由服务端校验主角色。`constants.js` 另外登记只允许更新自身私聊目标的 `bot_goal` |
| `host/resume.js` | 不把重启前的目标自动回合转换为普通恢复提示重放，普通用户／协作工作沿用原恢复路径 |
| `host/tools.js` | 主 Bot 的 `stop_bot` 先冻结目标续跑，再沿用上游停止与回执路径；工具和提示词过滤使用上游宿主级实现 |
| `host/learning.js`、`host/capabilities.js` | 保留上游提案应用流程，异步准备后及实际写入前重新校验设备学习审批授权 |
| `client/command-actions.js` | `extras.privateGoal.schema:1` 时，私聊裸 `/goal` 打开目标设置；群入口不变 |
| `host/prompt.js` | 主 Bot 先暂停并取得回执，再新建干净会话；禁止盲目重试、重放非幂等任务或把切换成功当作故障恢复 |
| `shared/browser-endpoints.js`、`shared/remote-endpoints.js` | 按上游权限分类逐项登记增补端点；团队默认、委派、历史 diff 与资源读写分别验权，完整消息不授予终端／文件／学习审批权限，不放开原本机端点或 DSH Agent 浏览器权限 |
| `client/settings.js` | 通用 → 基础插入默认消息发送方式与默认归档开关，不依赖 DSH 是否注册 `composer-enter` 插槽 |
| `client/bot-settings.js`、`phone-page.js` | 额外卡片／设备消息与资源授权，Manage 插入新建会话行；手机连接页插入服务器名称及仅显式关闭的用户终端清理入口，旧服务器按字段门控 |
| `client/team-actions.js` | 设置、当前 Session 新建请求、后台任务读取及固定的用户终端清理端点 |
| `client/index.js`、`app/ui/src/team.js` | 合并增补 live 字段；原生 `toolFace` 注入公开 ChatSnapshot 的连续工具分组源 |
| `client/cells.js`、`bot-tasks.js` | 复用增补工具摘要和纯文本消息组件；原生工具节点按连续段只保留一个摘要，历史 ChatRows 合并连续工具行，详情格式见 [tool-display.md](tool-display.md) |
| `app/ui/src/chat.js`、`app/vite.config.js` | 群聊读取增强页、合并刷新，未知旧接口才回退；私聊保留上游 Session 分页与订阅；增补子目录的 UI primitives 按实际路径映射到桌面实现 |
| `mobile/src/connection.ts` | 只增可选字段，不破坏原状态契约 |
| `mobile/src/team/link.ts`、`gate.ts` | 发送前手机门禁、增强读取、撤销时拒绝旧回包 |
| `mobile/src/screens/Settings.tsx`、`manage.tsx` | 一处设置组件插入 |
| `mobile/src/screens/Chat.tsx`、`chat/items.tsx` | 一处任务入口、工具／状态行及授权缓存隔离 |
| `link/src/pairing.ts` | 原公钥匹配后才刷新名称，保留类别与配对时间 |

`manifest.json` 的 `anchor` 保留原接入检查；同一文件的新增接入由可选 `anchors` 逐项验证。新建会话还需语义核对 `runMaintenance`、`startSwitch` 的错误／恢复流程、`save({ required: true })` 的所有权索引、模型／权限应用和 `moveSchedules`；不能仅凭锚点存在断言兼容。

`extra-*` 是新增协议，不把 `job_output` 名称、普通聊天文字或“未确认”当作完整工具结果。增强字段仅增强客户端使用，原 `chat`／`steps:true` 等旧调用保留原格式。

`logPage` 与归档活动读取显式传入真实 `throughSeq`，兼容旧宿主的必填分页契约；同一次增补扫描共享固定切面。旧会话只用 `sessionController.projections` 的 `sequenced/asOfSeq` 或已加载 Agent，不为补参数激活会话；无可靠序号、迁移中或授权拒绝时明确失败。此修复属于既有 `extras/` 模块，不增加原文件接入点。

PTY 与工作区已注册有限端点，只有公开服务存在时声明相应能力；配对授权默认关闭。终端使用 `subprocess.spawnTerminal` 创建插件用户 PTY，不接管 Agent／DSH 已有终端；输出读取不抢控制权。文件保存使用 `replaceIfVersion` 和单次回执，历史 diff 只取成功结果 `meta.diffs`，不从参数伪造。协议见 [resources.md](resources.md)，接口依据及跨进程／TOCTOU 的保证上限见 [resource-audit.md](resource-audit.md)。静态检查不能解除真实宿主和强文件隔离验收门禁。

资源权限更改会轮换设备资源代次、关闭读取会同时关闭写入；消息授权保持独立。句柄、保存回执和终端输入序号都绑定身份，不得在断线、撤销或切换目标后自动重放。用户终端存活时保留归档保护，换段或删除配对后仍可在电脑明确清理；关闭面板不结束进程。

团队默认通过 `extra-defaults-set` 串行保存到 `state.extras.defaults`，只接受 `messageMode` 和 `autoArchive`；回包能力为 `extras.defaults: { schema: 1, messageMode, autoArchive }`。消息优先级是 Bot 显式值 → 团队显式值 → 输入框原模式（缺省 queue）。团队消息初值为 `inherit`（使用 DSH 默认值），保持未配置时的原发送行为；显式团队 queue／steer 与 Bot 覆盖一样传入真实 prompt。前台／隐藏工作隔离采用上游规则，不修改已有排队消息或群聊、任务、协作、定时输入。

归档默认关闭，Bot 的显式 `true`／`false` 优先；缺失或 `null` 跟随团队默认，Web 和手机可恢复“跟随基础设置”。取消原来“选择 queue 就隐式开启归档”的关联，旧的显式归档设置保持不变；原本只靠 queue 隐式开启的 Bot 会跟随默认关闭，需要在通用基础启用默认或单独开启。仍只处理超过 24 小时的已结束旧段，执行前重新核对当前有效开关和原运行保护，不删除历史。保存失败回退，普通默认值不能混写设备授权或权限字段。

主 Bot 管理工具缺失的历史根因见上游 [#2107](https://github.com/Fei-Craft/DS-Bot/issues/2107)、[#2070](https://github.com/Fei-Craft/DS-Bot/pull/2070) 与 [#2123](https://github.com/Fei-Craft/DS-Bot/pull/2123)：Agent 上注册的监听器也可收到其他 Session 的请求。v0.4.0 已改为宿主级 `filterBuiltinTools` 与 `scopeTeamTools`，本增补沿用该实现，不再叠加 0.3.10 的逐 Agent 修补。每轮角色冻结和执行时验权保持上游行为；`bot.packs` 不控制内置 `team-admin`，不能用改团队配置代替修复。

主 Bot 工具复用现有 `cancel`／`whenIdle` 和干净新建流程；`pause_bot` 只暂停当前私聊并给出续接回执，`stop_bot` 沿用上游同时停止当前轮次和任务、静默记录原因的语义。`discard_queued` 默认 `false`，只有显式 `true` 才允许丢弃队列并报告数量；暂停回执绑定调用方、调用会话、目标当前私聊、模型／权限／工作目录和 10 分钟时效，新输入／新轮次会使其失效。同一前台线程的旧私聊仍有 `state.switching` 标记时拒绝再次操作，不误拦独立群聊或后台任务；`handoff_pending` 与 `recovery_verified` 如实反映交接和未验证恢复。

服务器扫码名称复用仅电脑本机可调用的 `phone-set`，不新增远程端点。可选 `serverName` 保存在现有 `phone.json`；空值删除覆盖并回退 `hostname()`，读取视图始终提供字符串 `phone.serverName`，旧服务器没有该字段时隐藏编辑入口。上限沿用配对／握手的 64 个 UTF-16 代码单元；名称不参与身份或授权判断，不更新手机已保存的名称。名称保存失败恢复原内存值，已有二维码只更新名称而不另开配对窗口或延长有效期。

私聊目标由 `extra-goal-control` 按目标编号、当前会话和 revision 修改，目标保存在 `bot.extras.goal`，通过 `extras.privateGoal.schema:1` 宣告入口。只有 Bot 显式 `steer` 或跟随基础 `steer` 才能启动、恢复和续跑；切离 `steer` 先冻结并暂停，切回后手动恢复。模式变更期间也拒绝并发启动，避免旧模式检查通过后在新模式中投递。正常换段保留；停止、手动新建与重启暂停；只有有待续跑事项且当前私聊不存在其他待处理工作时才追加目标提示。`bot_goal` 只能更新当前私聊已有目标，不能替用户开启或恢复。具体状态、并发保护和验收见 [private-goal.md](private-goal.md)。

资源读取续轮补齐三处契约：工具列表按实际调用序号消除重复事件、结果按调用区间关联，真实参数中的短说明仅在密钥保护就绪时脱敏投影；内部协作只为原交换账本中仍可核对且非私密的 Bot 对附加 `exchange`；工作区声明 `readOnlyPreview:true`，`extra-workspace-read` 的可选 `readOnly:true` 不分配编辑回执。终端关闭同时等待输出排空和 `done`，避免关闭回包缺少迟到退出事实。

恢复关联的新增锚点为 `const unblockBot = (botId, id, session, turn, seq, watched) => {`，已登记到原 `turns.js` 清单。新阻塞保存 `sessionId/turn/seq`，正常完成只在观察到同会话、不早于失败的轮次、较新事件和同提供方时撤销，`bot.recovery` 保留失败／完成序号；无关联的旧阻塞保持保守，凭据／模型变更的原清理路径不变。以上源码不代表用户故障已复现或已部署。

## 升级顺序

1. 用户明确选定下一份正式 Release，记录 tag 与完整提交。
2. 在独立干净目录验证原版插件、link、手机与桌面构建；不要先带入增补。
3. 比较清单中的 36 个接入文件，优先采用上游已有实现，仅保留明确需求差异；尤其核对 prompt、inbox、归档／卸载、配对、错误事件、PTC 与分页契约。锚点文本相同也不代表语义兼容。
4. 只移植独立目录和逐个固定接入点。未知协议／任务状态应失败或跳过，不静默猜测。
5. 更新 `manifest.json`、检查脚本、固定测试及 release workflow 中原版 checkout 的 SHA；重新编号增补／包版本。
6. 重新生成 `client.js`／`link.js`／`office.js`，运行双方独立验证。若原版失败，优先定位上游／环境；原版成功而增补失败，再定位增补。
7. 用新 tag 发布 npm `.tgz` 和校验信息，先在数据副本验收，再用于正式数据。

## 回滚

退出全部使用同一数据的 DS Bot 宿主。保留增补源码和数据备份，不重置用户 Git 工作区、不删会话日志。重新安装原版正式包；`extras` 字段是增补字段，但不应依赖原版永久保留未知字段，重要授权和设置请备份。再次使用增补版时逐设备重新核对授权，不要仅凭名称恢复权限。

生成文件未在本机更新；当前源码本身不是已验收的可安装二进制。正式交付以 CI／用户成功构建并验证的安装包为准。
