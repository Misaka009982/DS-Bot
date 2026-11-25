const ZH = {
  'New session': '新建会话', 'Confirm new session': '确认新建会话', 'Starting new session…': '正在新建会话…',
  'Start with a clean context. Keep memory and Bot settings.': '开启干净的上下文，保留记忆和 Bot 设置。',
  'Click again to start without the previous context. Earlier chats remain readable.': '再次点击，不携带上一段上下文开始；旧聊天仍可查看。',
  'Extra settings': '增补设置', 'Message delivery': '消息发送方式', 'Follow basic settings': '跟随基础设置',
  'Queue — wait for the turn': 'queue · 等当前回合结束', 'Steer — join the current turn': 'steer · 自动插话',
  'Applies to new messages. Steer is read at the next safe model/tool boundary; no ↑ click is needed.': '对新消息生效。插话在下一个安全的模型／工具边界处理，无需再点 ↑。',
  'Archive inactive sessions': '归档过期会话', 'Only ended background sessions and earlier parts inactive for over 24 hours. Keeps history; skips queues, approvals and running work.': '只归档最后活动超过 24 小时的已结束后台会话和旧段，保留历史；排队、审批及运行中的工作会跳过。',
  'Allow remote permission changes': '允许远程修改 Bot／群权限', 'Computer authorization only. The phone also needs its safety switch and a device unlock. Browser devices remain blocked.': '只能在电脑授权；手机还需开启防误触开关并解锁。浏览器权限设备仍不可修改。',
  'Allow full messages': '允许查看完整消息', 'Includes internal Bot collaboration and redacted model failures. Does not allow more remote actions.': '包括 Bot 内部协作及脱敏后的模型失败详情，不会开放更多远程操作。',
  'Computer authorization required': '需要电脑授权', 'Permission safety switch': '远程权限防误触开关',
  "Each Bot's own permission": '跟随每个 Bot 自身权限', 'Permission changes need the phone app.': '修改权限需要原生手机应用。',
  'Read only': '只读', 'Workspace': '工作区权限', 'Full access': '完全权限',
  'This phone may change permissions': '允许本手机修改远程权限', 'Off by default for each paired computer. Every permission change still asks for a device unlock.': '每台配对电脑默认关闭。每次修改权限仍需设备解锁。',
  'Used {count} tools': '用了 {count} 个工具', 'Success': '成功', 'Failed': '失败', 'Unconfirmed': '未确认',
  'Arguments': '参数', 'Output': '输出', 'Load more': '加载更多', 'Loading…': '正在读取…', 'Retry': '重试',
  'Tool details': '工具详情', 'Redacted; loaded only when opened.': '已脱敏；仅展开时读取。',
  'This server provides names and states only. Parameters and output require the extra module.': '此服务器只提供工具名称和状态；参数与输出需要增补模块。',
  'Internal collaboration': '内部协作', 'Model status': '模型状态', 'Full message access authorized on the computer': '电脑已授权查看完整消息',
  'To-do': '执行待办', 'Shared to-do': '共享待办', 'No to-dos in the recent history': '最近历史没有待办清单',
  'Pending': '待处理', 'In progress': '进行中', 'Completed': '已完成', 'Canceled': '已取消',
  'Background tasks': '后台任务', 'Task history': '任务过程', 'No background tasks': '暂无后台任务',
  'Close': '关闭', 'Save failed': '保存失败', 'Read failed': '读取失败', 'Refresh': '刷新',
}
export function extraText(key, lang = 'en', params = {}) {
  const text = String(lang).toLowerCase().startsWith('zh') ? ZH[key] ?? key : key
  return text.replace(/\{(\w+)\}/g, (all, name) => params[name] === undefined ? all : String(params[name]))
}
