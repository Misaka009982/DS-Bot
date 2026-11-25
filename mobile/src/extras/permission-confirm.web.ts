// 浏览器不能通过权限写入门禁；此函数也不得弹框冒充原生设备解锁。
export async function confirmPermission(): Promise<boolean> { return false }
