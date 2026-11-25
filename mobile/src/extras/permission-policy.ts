const CHANGES = new Set(['update-bot', 'update-room', 'create-bot', 'create-room'])
export function permissionWrite(endpoint: string, payload: unknown): boolean {
  return CHANGES.has(endpoint) && payload !== null && typeof payload === 'object' && Object.hasOwn(payload, 'permission')
}
