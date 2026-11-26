# DS-Bot 只读委派协议（schema 1）

这是插件源码契约，不是部署或联调证明。对应固定的 DSH `0.2.2-rc.1` 公开宿主服务 `ctx.subagents` 与 `ctx.sessionQuery.observeSession`。不安装额外依赖，不加载、恢复或控制 Agent，不接管普通 `bot-task-read`，不提供任意 Session 读取代理。

## 能力和鉴权

- `extra-status` 和团队 `state.extras` 的 `delegations: { schema: 1, read: boolean }` 是本子协议的能力声明；字段缺失表示宿主服务未就绪，不探测旧端点。`read: false` 表示当前远程调用方未获授权；会话和密钥库仍在调用时逐次验证。
- 手机或浏览器配对设备使用电脑「设置 → 连接 → 手机」已有的**完整消息**授权，按 deviceId、公钥和配对时间绑定；远程不能自行授权。设备更换或撤销时，在异步读取边界和返回前重新拒绝。不能用客户端名、`fullMessages` 自报或仅有 Gateway 身份代替配对授权。
- `scope` 决定可读会话：前台 Bot（包括历史段）、指定群（群自身段或仍属于该群的成员段）、指定后台任务的自身段，或已属于团队的 DSH Agent 会话。沿用原限制：浏览器设备不可读 DSH Agent 的 `agent` 范围；不能表面填群名、实际读其他群、Bot 私聊或任意会话。
- `rootSessionId` 必填、精确匹配，不会因 Bot 换会话自动改到新段。子路径逐级验证父自有目录；本地子记录还需匹配子 Session 的 `origin`、`parentSession` 和创建时间。后台任务首段应用已存的 `startSeq`，缺失边界则拒绝；继承前缀不能提供目录或过程。

## 固定端点

请求共有 `scope`、`rootSessionId`、可选 `childPath` 和 `limit`。`scope` 只接受以下四种形状（编号示例均非真实数据）：

```json
{ "kind": "bot", "botId": "bot-1" }
{ "kind": "room", "roomId": "room-1" }
{ "kind": "task", "botId": "bot-1", "taskId": "task-1" }
{ "kind": "agent", "agentId": "agent-1" }
```

`limit` 默认 20，范围 1–32。`childPath` 是由根向下的子编号路径，最多读取到第 8 层；不能出现根或重复编号。不接受其他字段。错误沿用 `bot/invalid`（无效请求）、`bot/refused`（对象／授权不符或请求取消）、`bot/not-found`（目录边或子会话不存在）、`bot/stale`（游标失效）、`bot/unavailable`（服务、历史边界、密钥库或数据不可读）及 `bot/busy`（宿主并发上限）。不转发原始存储错误或模型错误正文。

### `extra-delegation-list`

- 省略 `childPath` 或传 `[]` 读取根的直接子级；否则逐级定位末尾父级并返回它的直接子级。外部执行无下级会话。继续页传上一页的 `nextAfterChildId` 作为 `afterChildId`，保留相同父范围；不存在的游标明确报错。
- 返回 `{ schema, rootSessionId, parentSessionId, items, nextAfterChildId, depthLimit }`。`items` 保持 DSH 目录顺序；每项 `{ childId, mode, createdAt, label, status, statusSource, runId, lastSettlement }`。`mode` 为 `continuable`、`one-shot`、`external` 或 `unknown`。不为列目录逐个读取子日志。`label` 仅来自真实目录并在脱敏后截断，缺失为 `null`。
- `status` 可为 `running`、`completed`、`failed`、`canceled`、`limited`、`refused`、`interrupted` 或 `unknown`。`statusSource` 为 `live-agent`、`lifecycle`、`settlement` 或 `null`；`runId` 仅在有进程内生命周期记录时可用。父轮次和其他任务状态不作为子状态依据。进程重启后若只有可续接子级的旧结算通知，当前状态仍为 `unknown`，历史结算放在 `lastSettlement: { seq, status }`。单次执行可从带来源的持久结算通知恢复状态，未识别摘要一律为 `unknown`。

### `extra-delegation-read`

- `childPath` 至少一个子编号。返回 `{ schema, rootSessionId, parentSessionId, child, history, throughSeq, events, cursor, lastTurn, result }`。`child` 与列表项结构相同。
- `history: 'session'` 时按固定 `throughSeq` 向前分页，页面内部按时间线（seq 升序）返回；下一页交回 `cursor: { childId, throughSeq, beforeSeq }`，首次读取或刷新不用游标。`cursor: null` 表示到头；过滤后空页仍可能有下一页。每页最多扫描 4096 个事件，且只有子会话自己的轮次边界、助手文本和工具调用／结果的有限元数据。不传用户提示词、思维链、系统配置、附件、工具参数或原始工具输出。
- `lastTurn` 是当前切面找到的最新子轮次记录 `{ turn, seq, status, result }`，开放轮次为 `open`；其结果是该轮留下的助手文本，不等同于整个委派成功。
- `result` 优先返回 DSH `subagent/end` 的结算输出 `{ source: 'lifecycle', runId, text, truncated }`；无此记录时只使用父会话带 DSH 来源的最近持久通知 `{ source: 'settlement', seq, text, truncated }`。后一项是历史通知，子级再次运行时不表示当前运行已结束。只传脱敏纯文本，不从自然语言回复、工具名字或 DS-Bot 任务推测结果。最多在父最近 4096 个事件内查找通知；没有证据为 `null`。
- `history: 'external'` 的 DSH 委派没有本地子 Session，`throughSeq`、`cursor`、`lastTurn` 为 `null`，`events` 为空；仍可返回真实生命周期／父通知。外部没有记录时不补造结果。
- 助手过程单条至多 1024 个 UTF-16 代码单元，结果和子轮次最后文本至多 8192；原始拼接超过 64 Ki 单元时正文不传、`truncated: true`。屏幕显示按纯文本渲染。密钥库锁定则失败关闭。持久目录查询与本地子历史都使用 DSH 自身的只读观察，外围同时限制四个在途请求。

## 接线与验收

Deck 只在当前服务器声明 `delegations.schema === 1` 且 `read === true` 时发上述精确端点。按服务器、根、子路径和当前设备授权隔离缓存；关闭面板停止分页，切服、重配、撤销、`HTTP_401` 或 `HTTP_403` 时清除旧正文和迟到回包。不回退到任意 DSH history 或后台任务。当前仅有源代码与回归定义，真实版本、冷历史和端到端联调仍需用户／CI 验收。
