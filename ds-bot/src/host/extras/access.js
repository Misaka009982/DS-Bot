const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined

// 授权来自电脑保存的记录；名称、请求中的开关和客户端自报信息都不能提权。
export function fullMessagesAllowed(settings, device) {
  if (device === undefined || !['phone', 'browser'].includes(device.kind)) return false
  const grant = own(settings?.deviceAccess, device.deviceId)
  return grant?.fullMessages === true && grant.identityKey === device.identityKey && grant.pairedAt === device.pairedAt
}

export function learningApprovalAllowed(settings, device) {
  if (device === undefined || !['phone', 'browser'].includes(device.kind)) return false
  const grant = own(settings?.deviceAccess, device.deviceId)
  return grant?.learningApproval === true && grant.identityKey === device.identityKey && grant.pairedAt === device.pairedAt
}

export function remoteExtras(view, settings, device) {
  if (view === null || typeof view !== 'object' || view.extras === undefined) return view
  return { ...view, extras: { ...view.extras, fullMessages: fullMessagesAllowed(settings, device),
    learningApproval: { schema: 1, allowed: learningApprovalAllowed(settings, device) } } }
}
