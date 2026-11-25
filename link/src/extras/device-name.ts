// 只清理显示名称，不接触设备身份、配对日期或权限类别。
export function cleanDeviceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim()
  return text === '' ? undefined : Array.from(text).slice(0, 64).join('')
}

export function refreshDeviceName(device: { name: string }, value: unknown): boolean {
  const name = cleanDeviceName(value)
  if (name === undefined || name === device.name) return false
  device.name = name
  return true
}
