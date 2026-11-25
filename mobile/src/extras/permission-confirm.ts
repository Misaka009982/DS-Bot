import { Alert } from 'react-native'

export function confirmPermission(payload: unknown): Promise<boolean> {
  if (payload === null || typeof payload !== 'object' || !('permission' in payload) || payload.permission !== 'danger-full-access') return Promise.resolve(true)
  return new Promise(resolve => Alert.alert('允许完全权限？', '这会放宽此 Bot／群的工具执行限制。只在信任其任务、工作目录和工具时允许。', [
    { text: '取消', style: 'cancel', onPress: () => resolve(false) },
    { text: '允许完全权限', style: 'destructive', onPress: () => resolve(true) },
  ], { cancelable: true, onDismiss: () => resolve(false) }))
}
