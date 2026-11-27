// Endpoints that an authenticated browser device (`kind === 'browser'`) may call
// over the remote link. Everything not listed here — including all native-unlock
// GATED endpoints, phone pairing, connector/IM/mail/local-agent/computer-use
// management, secret vault controls, provider mutation/probing, and any future
// host endpoint — is refused fail-closed on both the host and the web client.
export const BROWSER_ALLOWED = new Set([
  // Team state, metadata, diagnostics, and read-only views
  'hello', 'state', 'notices', 'avatar', 'models', 'efforts', 'providers',
  'usage', 'usage-summary', 'run-stats', 'update-check',
  'diagnostics', 'diagnostics-log', 'diagnostics-clear',
  // Chat, group chat, attachments, cards, and safe pending-request cancellations
  'chat', 'room-chat', 'send', 'stage-image', 'image', 'markdown-image',
  'file-text', 'file-download', 'stop-chat', 'stop-room-work',
  'extra-attachment-open', 'extra-attachment-chunk', 'extra-attachment-send', 'extra-attachment-status', 'extra-attachment-discard',
  'answer-question', 'dismiss-question', 'view-reply', 'dismiss-view',
  'approval-answer', 'btw-delete', 'secret-cancel', 'connector-request-cancel',
  // Bot background tasks
  'bot-stop-task',
  // 增补的只读消息／工具／待办接口；fullMessages 仍由电脑逐设备验权。
  'extra-status', 'extra-tool-detail', 'extra-tool-change', 'extra-tool-list', 'extra-todos', 'extra-messages', 'extra-task-read',
  'extra-delegation-list', 'extra-delegation-read',
  'extra-bot-set', 'extra-defaults-set', 'extra-new-session', 'extra-goal-control',
  // 资源端点由服务端逐设备分开校验读写授权、根目录与句柄归属。
  'extra-terminal-list', 'extra-terminal-read', 'extra-terminal-create', 'extra-terminal-input', 'extra-terminal-resize', 'extra-terminal-close',
  'extra-workspace-open', 'extra-workspace-list', 'extra-workspace-read', 'extra-workspace-save', 'extra-workspace-save-status', 'extra-workspace-change',
  // Side questions
  'side-new', 'side-ask', 'side-cancel', 'side-close',
  // Bot and group management
  'create-bot', 'update-bot', 'duplicate-bot', 'delete-bot', 'set-main',
  'create-room', 'update-room', 'delete-room',
  // Folders, workspace, schedules, and memory
  'folders', 'folder-list', 'team-workspace',
  'schedules', 'schedule-create', 'schedule-delete', 'schedule-pause',
  'memory-view', 'memory-ask', 'memory-add', 'memory-edit', 'memory-forget',
  // Bot browser handoff controls
  'browser-frame', 'browser-takeover', 'browser-give-back', 'browser-stop',
])
