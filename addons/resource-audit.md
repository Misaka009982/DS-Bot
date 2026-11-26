# PTY 与工作区文件接线核对

本页记录固定 DSH `0.2.2-rc.1` 的公开证据、已实现适配和仍需实际部署验证的边界。用户反馈服务器版本均为 `v2.0.0-rc` 以上，该版本称呼与宿主包版本的对应关系、平台和执行后端尚未核验；本机未下载或安装 SDK，未运行宿主、测试或构建，未修改 DSH、用户数据或 Deck。

## 已实现的服务端范围

委派、用户 PTY、受限工作区文件和历史修改记录已写入独立增补模块。委派协议见 [delegations.md](delegations.md)，资源 DTO、预算、授权和结果状态见 [resources.md](resources.md)。源码和回归定义不等于可安装成品；生成客户端、实机验证与发布仍未完成。

## 终端选择依据

最初核对的公开 `terminalController.attach(agent, id, signal)` 会把输入与尺寸控制权交给最新连接；`retain` 只保活、不返回屏幕。因此不能将它们包装成“不抢控制权的只读观察”，也不能读取 controller 内部终端表。

继续核对确认了更底层但仍公开的 `ctx.subprocess.spawnTerminal`：它分配真实 PTY、提供输出字节流、输入、resize、done 和等待整个进程范围停稳的 `terminate`；与挂载的文件服务共用执行世界。`terminalEnvironment` 与 `resolveExecutable` 分别提供执行环境 shell 和可执行路径验证。分配信号只取消尚未完成的分配，成功后由返回句柄拥有生命周期。

本次通过该接口创建插件拥有的用户终端，分别授权输出和控制，输出观察不争抢控制权；不桥接任意 Gateway，也不创建 owner Peer。设备原链路仍为有限的请求／回包，使用有界字节游标和单次输入序号适配。创建只来自明确端点，面板探测和列表读取不会启动进程。

这解决了插件新建终端的只读观察问题，不能据此宣称可以无影响地镜像所有原 DSH 终端。原 Agent 终端、DSH 已有终端及完整恢复屏幕仍不接管。断线后保留有限尾部字节而非伪造屏幕；若后续产品要求原终端共享，仍需上游不抢控制权的公开观察 API。

证据：

- [Subprocess 公开服务及同执行世界契约](https://unpkg.com/@deepseek-ai/dsh-subprocess@0.2.2-rc.1/lib/types/index.d.ts)
- [PTY 分配、句柄和取消类型](https://unpkg.com/@deepseek-ai/dsh-subprocess@0.2.2-rc.1/lib/types/types.d.ts)
- [TerminalController 公开声明](https://unpkg.com/@deepseek-ai/dsh-api-terminal-controller@0.2.2-rc.1/lib/types/index.d.ts)
- [原终端权限、控制权与恢复说明](https://unpkg.com/@deepseek-ai/dsh-api-terminal-controller@0.2.2-rc.1/README.zh.md)

## 文件选择依据及保证上限

`ctx.workspaceFiles` 是只读服务，文件预览允许越过工作区根；本次没有原样转发它。使用公开 `ctx.fs` 的 `resolve`、`lstat`、`stat`、`contains`、`readBytes`、`listDir` 和带 `replaceIfVersion` 的 `writeText`。插件增加配对设备独立读写授权、服务端根句柄、敏感路径拒绝、版本和完整内容复核、单次编辑回执以及明确的不确定结果。

成功修改详情来自 `FsWriteOutcome.before`／`after`。历史工具 diff 来自成功结果事件的 `data.meta.diffs`，不是工具调用参数；`apply_patch` 停止时只保留已知部分效果，旧文本缺失不推断为新建。

这些公开能力足以实现常规“打开后文件已变化则拒绝旧版本保存”，仍有两个不能由插件宣称解决的后端限制：

1. `fs-local` 的目标写锁只串行化当前进程中走该服务的写入。外部 shell／CLI 不受该锁约束；版本前置检查之后、原子发布之前仍可能发生外部写入。若要求任何外部竞争都绝不覆盖，必须由部署后端提供更强的条件写保证，或让所有写入进入同一受控边界。
2. `fs-sandbox` 明确接受从重新规范化到系统调用之间的剩余祖先链接 TOCTOU，读取也不是内核级沙箱围栏。插件逐级拒绝链接并前后重验、校验真实敏感名称，但无法把路径 API 变成固定目录句柄的内核隔离。

授权默认关闭，文件编辑确认说明上述限制；本次未取得用户实际部署的保证，也未把原“强隔离／任意外部竞争不覆盖”验收标为通过。生产启用前须按实际后端验证和隔离；需要强保证而后端不支持时保持编辑关闭。不能使用裸 `node:fs` 绕开执行世界或修改 DSH 来掩盖缺口。

证据：

- [WorkspaceFiles 越根预览语义](https://unpkg.com/@deepseek-ai/dsh-api-workspace-files@0.2.2-rc.1/lib/types/index.d.ts)
- [FileSystem 公开方法](https://unpkg.com/@deepseek-ai/dsh-fs@0.2.2-rc.1/lib/types/index.d.ts)
- [版本前置条件与实际修改结果](https://unpkg.com/@deepseek-ai/dsh-fs@0.2.2-rc.1/lib/types/types.d.ts)
- [本地后端原子写入与跨进程限制](https://unpkg.com/@deepseek-ai/dsh-fs-local@0.2.2-rc.1/README.zh.md)
- [沙箱规范化及 TOCTOU 威胁模型](https://unpkg.com/@deepseek-ai/dsh-fs-sandbox@0.2.2-rc.1/README.zh.md)
- [工具成功结果的 diff 与部分补丁语义](https://unpkg.com/@deepseek-ai/dsh-tool-fs@0.2.2-rc.1/README.zh.md)
- [原生结果 metadata 的持久位置](https://unpkg.com/@deepseek-ai/dsh-session@0.2.2-rc.1/lib/types/types.d.ts)
- [PTC 子调用的持久结果字段](https://unpkg.com/@deepseek-ai/dsh-tool-executor-ptc@0.2.2-rc.1/lib/types/types.d.ts)

## 交付前仍需确认

1. 实际 DSH 版本及文件／PTY 提供方；方法存在只说明具备调用入口，不证明目标环境验收成功。
2. 用户／CI 生成客户端并执行 [验证清单](verification.md)，特别是两设备授权隔离、真实 shell 交互、输出截断、重配和撤销、关闭等待停稳、目录链接替换、文件竞争与断线后的未知结果。
3. 若继续接入 Deck，在独立客户端任务中按 [resources.md](resources.md) 接线，并验证切服务器、页面关闭、ANSI 与链接限制及未保存内容的保留。本轮没有修改 Deck。
4. 用户已明确改为先推送 `main` 并通过 CI 构建，再实际操作验收。构建产物供试用，仍保留未验证项，不据此宣称强文件隔离或所有宿主版本兼容，不自动升级 DSH 或更换数据目录。
