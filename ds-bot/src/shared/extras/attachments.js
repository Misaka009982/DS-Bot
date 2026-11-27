// 只投影真实用户消息里的附件元数据，不包含存储路径或上传回执。
export function userFileMetadata(content) {
  const files = (Array.isArray(content) ? content : []).filter(block => block?.type === 'file' && block.attachment)
    .slice(0, 32).map(({ attachment }) => ({ name: String(attachment.name ?? 'file').split(/[\\/]/).pop().replace(/[\p{Cc}]/gu, '').slice(0, 200) || 'file',
      ...(Number.isSafeInteger(attachment.bytes) && attachment.bytes >= 0 ? { bytes: attachment.bytes } : {}) }))
  return files.length ? { fileRefs: files } : {}
}
