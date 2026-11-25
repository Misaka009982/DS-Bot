// 名称仅用于普通文本显示，设备类别与授权不从名称推断。
export function deviceLabel(entry, translate) {
  const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
  return name || translate(entry?.kind === 'browser' ? 'Web browser' : 'Phone')
}
