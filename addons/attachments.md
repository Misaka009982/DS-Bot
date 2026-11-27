# 聊天附件协议（增补 1.2.2）

Deck 的原独立聊天输入框只发文字，原远程 `stage-image` 只收图片。新增协议用于用户主动选择的普通文件和图片，沿用加密配对链路及原 Bot／群聊发送权限，不要求工作区读写授权，不允许指定本机或宿主文件路径。

## 能力与接口

只有 DSH 提供公开 `fileUploads.uploadStream` 与 `uploadImageStream` 时，`state.extras.attachments`／`extra-status.attachments` 声明 `schema:1` 和以下数值：`maxFiles:8`、`maxFileBytes:16777216`、`maxTotalBytes:33554432`、`chunkBytes:196608`。接口缺失时客户端提示升级，不把普通文件伪装成图片或仅发送文件路径。

| 端点 | 请求 | 结果 |
| --- | --- | --- |
| `extra-attachment-open` | `{requestId, scope, sessionId, files:[{name,size,mime,kind}]}` | 建立当前设备与原会话的暂存记录；同编号同清单返回已有状态 |
| `extra-attachment-chunk` | `{requestId,index,offset,data}` | 按字节偏移追加规范 base64，返回每个文件已收字节数；相同最后分片重放不增加长度 |
| `extra-attachment-send` | `{requestId,text}` | 完整上传后提交一次消息，重复相同请求只返回原状态 |
| `extra-attachment-status` | `{requestId}` | 只查询当前设备原回执，不发送消息 |
| `extra-attachment-discard` | `{requestId}` | 释放尚未提交的暂存字节；已在提交或结果未知不能撤销 |

`scope` 仅接受 `{kind:'bot',botId}` 或 `{kind:'room',roomId}`；`sessionId` 必须是其当前私聊或群公共会话。文件名为不含路径与控制字符的叶名称，最多200字符。普通文件保持原始字节；PNG、JPEG、WebP、GIF 经 DSH 图片上传服务校验和规范化。SVG、HTML 等作为普通文件，不在 Deck 执行或嵌入预览。

结果统一为 `{schema:1,requestId,sessionId,deliveredSessionId,status,expiresAt,received,message}`，不返回宿主路径、设备密钥或 DSH 上传回执。`status` 为 `uploading`、`sending`、`sent`、`failed`、`unknown`、`discarded`。`sent` 表示宿主 prompt 已接受，不表示模型处理成功。

## 归属与生命周期

远程所有者仅由已配对设备 ID、公钥、配对时间和类别生成摘要；请求不能自报所有者。另一设备、本地入口、删除后重新配对不能借编号取回暂存。两种配对模式可发送给原权限允许的 Bot／群；没有设备归属的其他远程载体拒绝新接口。只读状态不能开始上传或提交；状态查询仍需原设备授权。

每次分片和提交核对原会话及工作区身份。`sendUser` 继续决定原消息模式与正常前台交接，交接完成、最终接收 Session 确定后才领取 DSH 文件回执；上传前后和 prompt 前重新校验授权、目标及服务身份。只要任一文件在提交前失败，整条消息不提交；已写入 DSH 内容存储的孤立文件按 DSH 自身生命周期处理，不删除其存储文件。

暂存最多128条记录、每设备最多4个有字节的待传批次，宿主合计预留64 MiB；未完成及结算记录30分钟过期，分钟级回收，正在提交的记录不提前淘汰。完成／失败即释放暂存字节，仅保留回执元数据。进程重启或过期后查询返回失效，不能推定此前消息未发送。

提交后断线只查同一编号。`uploading` 或 `sending` 的查询也不能证明早先提交请求永远不会到达；`unknown` 保守保留。只有明确 `sent` 才标成功，明确 `failed` 才可由用户重新发送。用户可以在核对聊天后显式清除本地待确认记录；清除不会撤销服务器消息，不会自动重发。

## 验证与安装

公开契约已只读核对 `@deepseek-ai/dsh-client-file-upload@0.2.2-rc.1` 的 `uploadStream`、`uploadImageStream` 和 Session-owned receipt 声明；未修改 DSH 或安装目录。测试定义在 `extra-attachments.test.js`，真实发送接线在 `mobile.test.js`，真实配对边界在 `phone.test.js`。本机仅做静态核查，执行与打包由 CI 完成。

真实验收需要新 Deck 与服务端 `0.3.10-addons.5`：选文档和截图、仅附件发送、多文件、切服／换段、文件过大、断线与未知回执、浏览器权限及撤销设备。确认附件列表、服务器实际收到的文件字节及所属会话一致；CI 不能替代真实文件服务验收。旧 1.2.1 Release 和附件保留，不自动覆盖。
