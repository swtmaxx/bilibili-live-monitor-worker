export const MAX_UIDS_PER_REQUEST = 50;
export const MAX_BILIBILI_BATCHES_PER_RUN = 36;
export const MAX_OUTBOX_SENDS_PER_RUN = 10;

export function normalizeId(value) {
  const id = String(value ?? '').trim();
  if (!/^\d{1,20}$/.test(id)) {
    throw new Error('ID 必须是数字');
  }
  return id;
}

export function normalizeMonitorInput(input) {
  const type = String(input?.type ?? '').trim().toLowerCase();
  if (type !== 'uid' && type !== 'room') {
    throw new Error('监控类型必须是 uid 或 room');
  }
  const sourceId = normalizeId(input?.id ?? input?.source_id);
  const label = String(input?.label ?? '').trim().slice(0, 120);
  return { type, sourceId, label };
}

export function normalizeTargetInput(input) {
  const type = String(input?.type ?? '').trim().toLowerCase();
  if (type !== 'private' && type !== 'group') {
    throw new Error('通知目标类型必须是 private 或 group');
  }
  const targetId = String(input?.id ?? input?.target_id ?? '').trim();
  if (!targetId || targetId.length > 256) {
    throw new Error('通知目标 ID 不能为空且不能超过 256 个字符');
  }
  const label = String(input?.label ?? '').trim().slice(0, 120);
  return { type, targetId, label };
}

export function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function parseLiveStatus(value) {
  const status = Number(value);
  return status === 0 || status === 1 ? status : null;
}

export function formatTransitionMessage({ status, uname, title, roomId, format }) {
  const isStart = status === 1;
  const roomUrl = roomId ? `https://live.bilibili.com/${roomId}` : '';
  if (format === 'markdown') {
    if (isStart) {
      return [
        '**B站开播**',
        '',
        `**主播：** ${uname || '未知主播'}`,
        `**标题：** ${title || '未提供'}`,
        `**直播间：** ${roomUrl}`,
      ].join('\n');
    }
    return [
      '**B站下播**',
      '',
      `**主播：** ${uname || '未知主播'}`,
      `**直播间：** ${roomUrl}`,
    ].join('\n');
  }
  if (isStart) {
    return [
      '【B站开播】',
      '',
      `主播：${uname || '未知主播'}`,
      `标题：${title || '未提供'}`,
      `直播间：${roomUrl}`,
    ].join('\n');
  }
  return [
    '【B站下播】',
    '',
    `主播：${uname || '未知主播'}`,
    `直播间：${roomUrl}`,
  ].join('\n');
}

export function retryDelaySeconds(attempts) {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}
