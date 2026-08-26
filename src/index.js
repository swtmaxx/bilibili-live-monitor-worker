import {
  MAX_BILIBILI_BATCHES_PER_RUN,
  MAX_OUTBOX_SENDS_PER_RUN,
  MAX_UIDS_PER_REQUEST,
  chunk,
  formatTransitionMessage,
  normalizeMonitorInput,
  normalizeTargetInput,
  parseLiveStatus,
  retryDelaySeconds,
} from './core.js';

const BILIBILI_API = 'https://api.live.bilibili.com';
const QQ_API = 'https://api.bot.qq.com';
// A Cron invocation can run for up to 15 minutes. Keep the lease alive for
// the full window so a slow scan cannot overlap with the next invocation.
const LOCK_SECONDS = 15 * 60;
const tokenCache = new Map();
let htmlCache;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      if (url.pathname === '/health' && request.method === 'GET') {
        return cors(await health(env));
      }
      if (url.pathname === '/admin' && request.method === 'GET') {
        return new Response(adminHtml(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/api/auth/status' && request.method === 'GET') return cors(json(await authStatus(env)));
      if (url.pathname === '/api/auth/setup' && request.method === 'POST') return cors(await setupPassword(request, env));
      if (url.pathname === '/api/auth/login' && request.method === 'POST') return cors(await loginPassword(request, env));
      if (!url.pathname.startsWith('/api/')) return cors(json({ error: 'Not Found' }, 404));
      await requireAdmin(request, env);

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') return cors(await logout(request, env));

      if (url.pathname === '/api/status' && request.method === 'GET') return cors(json(await status(env)));
      if (url.pathname === '/api/qq-config' && request.method === 'GET') return cors(json(await getPublicQQConfig(env)));
      if (url.pathname === '/api/qq-config' && request.method === 'PUT') return cors(await updateQQConfig(request, env));
      if (url.pathname === '/api/monitors' && request.method === 'GET') return cors(json(await listMonitors(env)));
      if (url.pathname === '/api/monitors' && request.method === 'POST') return cors(await createMonitor(request, env));
      if (url.pathname === '/api/targets' && request.method === 'GET') return cors(json(await listTargets(env)));
      if (url.pathname === '/api/targets' && request.method === 'POST') return cors(await createTarget(request, env));
      if (url.pathname === '/api/settings' && request.method === 'GET') return cors(json(await getSettings(env)));
      if (url.pathname === '/api/settings' && request.method === 'PUT') return cors(await updateSettings(request, env));
      if (url.pathname === '/api/check' && request.method === 'POST') {
        const result = await runMonitorCycle(env, true);
        return cors(json(result, result.locked ? 409 : 200));
      }

      const monitorMatch = url.pathname.match(/^\/api\/monitors\/(\d+)(?:\/(resolve))?$/);
      if (monitorMatch) {
        const id = Number(monitorMatch[1]);
        if (monitorMatch[2] === 'resolve' && request.method === 'POST') return cors(await resolveMonitor(id, env));
        if (!monitorMatch[2] && request.method === 'PATCH') return cors(await updateMonitor(id, request, env));
        if (!monitorMatch[2] && request.method === 'DELETE') return cors(await deleteMonitor(id, env));
      }

      const targetMatch = url.pathname.match(/^\/api\/targets\/(\d+)$/);
      if (targetMatch) {
        const id = Number(targetMatch[1]);
        if (request.method === 'PATCH') return cors(await updateTarget(id, request, env));
        if (request.method === 'DELETE') return cors(await deleteTarget(id, env));
      }
      return cors(json({ error: 'Not Found' }, 404));
    } catch (error) {
      return cors(json({ error: publicError(error) }, error.status || 500));
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runMonitorCycle(env, false));
  },
};

async function requireAdmin(request, env) {
  const token = bearerToken(request);
  if (!token) throw httpError(401, '请先设置或登录管理员密码');
  const tokenHash = await sha256Hex(token);
  const session = await queryOne(env, `SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at>?`, tokenHash, nowIso());
  if (!session) throw httpError(401, '管理员会话已过期，请重新登录');
  await env.DB.prepare('UPDATE admin_sessions SET last_seen_at=? WHERE token_hash=?').bind(nowIso(), tokenHash).run();
}

function bearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice(7).trim();
  return request.headers.get('X-Admin-Session') || '';
}

async function authStatus(env) {
  const row = await queryOne(env, 'SELECT id FROM admin_auth WHERE id=1');
  return { configured: Boolean(row) };
}

async function setupPassword(request, env) {
  const existing = await authStatus(env);
  if (existing.configured) throw httpError(409, '管理员密码已经设置，请登录');
  const input = await readJson(request);
  const password = String(input.password || '');
  if (password.length < 12 || password.length > 256) throw httpError(422, '管理员密码长度必须是 12-256 个字符');
  const salt = randomBytes(16);
  const hash = await passwordHash(password, salt);
  await env.DB.prepare(`INSERT INTO admin_auth (id, password_salt, password_hash) VALUES (1, ?, ?)`)
    .bind(bytesToBase64(salt), hash).run();
  return json({ ok: true, token: await issueSession(env) }, 201);
}

async function loginPassword(request, env) {
  const input = await readJson(request);
  const password = String(input.password || '');
  const stored = await queryOne(env, 'SELECT password_salt, password_hash FROM admin_auth WHERE id=1');
  let valid = false;
  if (stored) {
    valid = (await passwordHash(password, base64ToBytes(stored.password_salt))) === stored.password_hash;
  }
  if (!valid) throw httpError(401, '管理员密码错误');
  return json({ ok: true, token: await issueSession(env) });
}

async function logout(request, env) {
  const token = bearerToken(request);
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await sha256Hex(token)).run();
  return json({ ok: true });
}

async function issueSession(env) {
  const token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll('-', '')}`;
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').bind(nowIso()),
    env.DB.prepare('INSERT INTO admin_sessions (token_hash, expires_at) VALUES (?, ?)').bind(await sha256Hex(token), expiresAt),
  ]);
  return token;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function publicError(error) {
  return error instanceof Error ? error.message.slice(0, 300) : '请求失败';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  headers.set('access-control-allow-headers', 'Content-Type,Authorization,X-Admin-Session');
  return new Response(response.body, { status: response.status, headers });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw httpError(400, '请求体必须是有效 JSON');
  }
}

async function queryOne(env, sql, ...bindings) {
  return env.DB.prepare(sql).bind(...bindings).first();
}

async function listMonitors(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, type, source_id, uid, room_id, label, enabled, live_status,
           last_title, last_checked_at, last_error, created_at, updated_at
    FROM monitors ORDER BY id ASC
  `).all();
  return { monitors: results || [] };
}

async function listTargets(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, type, target_id, label, enabled, created_at, updated_at
    FROM targets ORDER BY id ASC
  `).all();
  return { targets: results || [] };
}

async function getSettings(env) {
  const row = await queryOne(env, 'SELECT interval_minutes, notify_start, notify_end, format FROM settings WHERE id=1');
  return {
    interval_minutes: row?.interval_minutes ?? 1,
    notify_start: Boolean(row?.notify_start ?? 1),
    notify_end: Boolean(row?.notify_end ?? 1),
    format: row?.format === 'markdown' ? 'markdown' : 'text',
  };
}

async function getQQConfig(env) {
  const row = await queryOne(env, 'SELECT app_id, client_secret FROM qq_config WHERE id=1');
  return { appId: row?.app_id || '', clientSecret: row?.client_secret || '' };
}

async function getPublicQQConfig(env) {
  const config = await getQQConfig(env);
  return { app_id: config.appId, client_secret_configured: Boolean(config.clientSecret) };
}

async function updateQQConfig(request, env) {
  const input = await readJson(request);
  const current = await getQQConfig(env);
  const appId = String(input.app_id ?? current.appId).trim();
  const incomingSecret = String(input.client_secret ?? '').trim();
  const clientSecret = input.clear_client_secret ? '' : (incomingSecret || current.clientSecret);
  if (!appId || appId.length > 128) throw httpError(422, 'QQ AppID 不能为空且不能超过 128 个字符');
  if (!clientSecret || clientSecret.length > 512) throw httpError(422, 'QQ ClientSecret 不能为空且不能超过 512 个字符');
  await env.DB.prepare(`UPDATE qq_config SET app_id=?, client_secret=?, updated_at=? WHERE id=1`)
    .bind(appId, clientSecret, nowIso()).run();
  tokenCache.delete(appId);
  return json({ ok: true, ...(await getPublicQQConfig(env)) });
}

async function updateSettings(request, env) {
  const input = await readJson(request);
  const interval = Number(input.interval_minutes);
  const format = String(input.format ?? 'text');
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) throw httpError(422, '检查间隔必须是 1-60 的整数分钟');
  if (!['text', 'markdown'].includes(format)) throw httpError(422, '消息格式必须是 text 或 markdown');
  await env.DB.prepare(`
    UPDATE settings SET interval_minutes=?, notify_start=?, notify_end=?, format=?, updated_at=? WHERE id=1
  `).bind(interval, input.notify_start === false ? 0 : 1, input.notify_end === false ? 0 : 1, format, nowIso()).run();
  return json(await getSettings(env));
}

async function createMonitor(request, env) {
  const input = normalizeMonitorInput(await readJson(request));
  const resolved = await resolveInput(input, env);
  const existing = await queryOne(env, 'SELECT id FROM monitors WHERE type=? AND source_id=?', input.type, input.sourceId);
  if (existing) throw httpError(409, '这个监控对象已经存在');
  const label = input.label || resolved.uname || `B站${input.type === 'room' ? '直播间' : '主播'} ${input.sourceId}`;
  const result = await env.DB.prepare(`
    INSERT INTO monitors (type, source_id, uid, room_id, label, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).bind(input.type, input.sourceId, resolved.uid, resolved.roomId, label, nowIso()).run();
  return json({ ok: true, id: result.meta.last_row_id, resolved }, 201);
}

async function updateMonitor(id, request, env) {
  const input = await readJson(request);
  const fields = [];
  const values = [];
  if (input.label !== undefined) { fields.push('label=?'); values.push(String(input.label).trim().slice(0, 120)); }
  if (input.enabled !== undefined) { fields.push('enabled=?'); values.push(input.enabled ? 1 : 0); }
  if (!fields.length) throw httpError(422, '没有可更新的字段');
  fields.push('updated_at=?'); values.push(nowIso(), id);
  const result = await env.DB.prepare(`UPDATE monitors SET ${fields.join(', ')} WHERE id=?`).bind(...values).run();
  if (!result.meta.changes) throw httpError(404, '监控对象不存在');
  return json({ ok: true });
}

async function deleteMonitor(id, env) {
  const result = await env.DB.prepare('DELETE FROM monitors WHERE id=?').bind(id).run();
  if (!result.meta.changes) throw httpError(404, '监控对象不存在');
  return json({ ok: true });
}

async function resolveMonitor(id, env) {
  const monitor = await queryOne(env, 'SELECT id, type, source_id FROM monitors WHERE id=?', id);
  if (!monitor) throw httpError(404, '监控对象不存在');
  const resolved = await resolveInput({ type: monitor.type, sourceId: monitor.source_id, label: '' }, env);
  await env.DB.prepare(`UPDATE monitors SET uid=?, room_id=?, last_error=NULL, updated_at=? WHERE id=?`)
    .bind(resolved.uid, resolved.roomId, nowIso(), id).run();
  return json({ ok: true, resolved });
}

async function createTarget(request, env) {
  const input = normalizeTargetInput(await readJson(request));
  const existing = await queryOne(env, 'SELECT id FROM targets WHERE type=? AND target_id=?', input.type, input.targetId);
  if (existing) throw httpError(409, '这个通知目标已经存在');
  const result = await env.DB.prepare(`
    INSERT INTO targets (type, target_id, label, enabled, updated_at) VALUES (?, ?, ?, 1, ?)
  `).bind(input.type, input.targetId, input.label || input.targetId, nowIso()).run();
  return json({ ok: true, id: result.meta.last_row_id }, 201);
}

async function updateTarget(id, request, env) {
  const input = await readJson(request);
  const fields = [];
  const values = [];
  if (input.label !== undefined) { fields.push('label=?'); values.push(String(input.label).trim().slice(0, 120)); }
  if (input.enabled !== undefined) { fields.push('enabled=?'); values.push(input.enabled ? 1 : 0); }
  if (!fields.length) throw httpError(422, '没有可更新的字段');
  fields.push('updated_at=?'); values.push(nowIso(), id);
  const result = await env.DB.prepare(`UPDATE targets SET ${fields.join(', ')} WHERE id=?`).bind(...values).run();
  if (!result.meta.changes) throw httpError(404, '通知目标不存在');
  return json({ ok: true });
}

async function deleteTarget(id, env) {
  const result = await env.DB.prepare('DELETE FROM targets WHERE id=?').bind(id).run();
  if (!result.meta.changes) throw httpError(404, '通知目标不存在');
  return json({ ok: true });
}

async function resolveInput(input, env) {
  if (input.type === 'room') {
    const payload = await biliFetch(`/room/v1/Room/get_info?room_id=${encodeURIComponent(input.sourceId)}`);
    const data = payload.data || {};
    if (!data.uid || !data.room_id) throw httpError(422, 'B站直播间不存在或无法解析主播 UID');
    return { uid: String(data.uid), roomId: String(data.room_id), uname: data.uname || '' };
  }
  const payload = await biliBatchFetch([input.sourceId]);
  const data = payload.data?.[input.sourceId];
  if (!data?.uid || !data?.room_id) throw httpError(422, 'B站 UID 不存在或无法解析直播间');
  return { uid: String(data.uid), roomId: String(data.room_id), uname: data.uname || '' };
}

async function biliFetch(path) {
  const response = await fetch(`${BILIBILI_API}${path}`, {
    headers: { 'User-Agent': 'bilibili-live-monitor-worker/1.0', Referer: 'https://live.bilibili.com/' },
  });
  if (!response.ok) throw httpError(502, `B站接口 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0) throw httpError(502, `B站接口错误 ${payload.code}`);
  return payload;
}

async function biliBatchFetch(uids) {
  const params = new URLSearchParams();
  for (const uid of uids) params.append('uids[]', uid);
  return biliFetch(`/room/v1/Room/get_status_info_by_uids?${params}`);
}

async function health(env) {
  const job = await queryOne(env, `
    SELECT next_check_at, scan_active, scan_cursor, scan_total, scan_processed,
           last_started_at, last_finished_at, last_error, last_checked_count
    FROM job_state WHERE id=1
  `);
  let dbOk = true;
  try { await queryOne(env, 'SELECT 1 AS ok'); } catch { dbOk = false; }
  return json({ ok: dbOk, database: dbOk, job: publicJob(job) });
}

async function status(env) {
  const [job, monitors, targets, pending, qq_config] = await Promise.all([
    queryOne(env, `SELECT next_check_at, scan_active, scan_cursor, scan_total, scan_processed,
      last_started_at, last_finished_at, last_error, last_checked_count FROM job_state WHERE id=1`),
    queryOne(env, 'SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM monitors'),
    queryOne(env, 'SELECT COUNT(*) AS total, SUM(enabled) AS enabled FROM targets'),
    queryOne(env, `SELECT COUNT(*) AS total FROM outbox WHERE status='pending'`),
    getPublicQQConfig(env),
  ]);
  return {
    job: publicJob(job),
    monitors: { total: monitors?.total || 0, enabled: monitors?.enabled || 0 },
    targets: { total: targets?.total || 0, enabled: targets?.enabled || 0 },
    pending_outbox: pending?.total || 0,
    qq: qq_config,
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    next_check_at: job.next_check_at,
    scan_active: Boolean(job.scan_active),
    scan_cursor: job.scan_cursor,
    scan_total: job.scan_total,
    scan_processed: job.scan_processed,
    last_started_at: job.last_started_at,
    last_finished_at: job.last_finished_at,
    last_error: job.last_error,
    last_checked_count: job.last_checked_count,
  };
}

async function runMonitorCycle(env, force) {
  const now = Date.now();
  const current = await queryOne(env, `SELECT * FROM job_state WHERE id=1`);
  if (!current) throw new Error('D1 尚未执行迁移');
  if (!force && !current.scan_active && current.next_check_at && Date.parse(current.next_check_at) > now) {
    const settings = await getSettings(env);
    await processOutbox(env, settings.format);
    return { skipped: true, reason: 'not_due', next_check_at: current.next_check_at };
  }

  const token = crypto.randomUUID();
  const lockUntil = new Date(now + LOCK_SECONDS * 1000).toISOString();
  const lock = await env.DB.prepare(`
    UPDATE job_state SET lock_token=?, lock_until=?
    WHERE id=1 AND (lock_until IS NULL OR lock_until < ?)
  `).bind(token, lockUntil, nowIso()).run();
  if (!lock.meta.changes) return { locked: true };

  let checked = 0;
  try {
    let state = await queryOne(env, 'SELECT * FROM job_state WHERE id=1');
    if (!state.scan_active) {
      const total = await queryOne(env, 'SELECT COUNT(*) AS total FROM monitors WHERE enabled=1');
      const started = nowIso();
      await env.DB.prepare(`UPDATE job_state SET scan_active=1, scan_cursor=0, scan_total=?, scan_processed=0,
        last_started_at=?, last_error=NULL WHERE id=1`).bind(total?.total || 0, started).run();
      state = await queryOne(env, 'SELECT * FROM job_state WHERE id=1');
    }

    const settings = await getSettings(env);
    let batches = 0;
    while (batches < MAX_BILIBILI_BATCHES_PER_RUN) {
      const rows = await selectMonitorBatch(env, state.scan_cursor, MAX_UIDS_PER_REQUEST);
      if (!rows.length) {
        await finishScan(env, settings.interval_minutes, checked);
        break;
      }
      const result = await processMonitorRows(rows, settings, env);
      checked += result.checked;
      state = await advanceScan(env, rows.at(-1).id, rows.length);
      batches += 1;
      if (state.scan_processed >= state.scan_total) {
        await finishScan(env, settings.interval_minutes, checked);
        break;
      }
    }
    await processOutbox(env, settings.format);
    return { ok: true, checked, batches };
  } catch (error) {
    await env.DB.prepare('UPDATE job_state SET last_error=?, last_finished_at=? WHERE id=1').bind(publicError(error), nowIso()).run();
    return { ok: false, checked, error: publicError(error) };
  } finally {
    await env.DB.prepare('UPDATE job_state SET lock_token=NULL, lock_until=NULL WHERE id=1 AND lock_token=?').bind(token).run();
  }
}

async function selectMonitorBatch(env, cursor, limit) {
  const { results } = await env.DB.prepare(`
    SELECT id, type, source_id, uid, room_id, label, live_status, last_title
    FROM monitors WHERE enabled=1 AND id>? ORDER BY id LIMIT ?
  `).bind(cursor || 0, limit).all();
  return results || [];
}

async function processMonitorRows(rows, settings, env) {
  const uniqueUids = [...new Set(rows.map(row => String(row.uid)))];
  let payload;
  try {
    payload = await biliBatchFetch(uniqueUids);
  } catch (error) {
    await markBatchError(rows, publicError(error), env);
    return { checked: 0 };
  }
  const byUid = payload.data || {};
  const valid = rows.map(row => ({ row, info: byUid[String(row.uid)] })).filter(item => item.info);
  for (const group of chunk(valid, 25)) await persistMonitorGroup(group, settings, env);
  if (valid.length < rows.length) {
    const missing = rows.filter(row => !byUid[String(row.uid)]);
    await markBatchError(missing, 'B站响应中缺少该 UID', env);
  }
  return { checked: valid.length };
}

async function persistMonitorGroup(group, settings, env) {
  const observedAt = nowIso();
  const statements = [];
  for (const { row, info } of group) {
    const currentStatus = parseLiveStatus(info.live_status);
    if (currentStatus === null) {
      statements.push(env.DB.prepare(`UPDATE monitors SET last_checked_at=?, last_error=?, updated_at=? WHERE id=?`)
        .bind(observedAt, `B站状态 ${info.live_status} 不作为开播/下播判断`, observedAt, row.id));
      continue;
    }
    const previousStatus = row.live_status === null || row.live_status === undefined ? null : Number(row.live_status);
    const title = String(info.title || '');
    const roomId = String(info.room_id || row.room_id || '');
    const uname = String(info.uname || row.label || '');
    statements.push(env.DB.prepare(`UPDATE monitors SET uid=?, room_id=?, last_title=?, live_status=?, last_checked_at=?, last_error=NULL, updated_at=? WHERE id=?`)
      .bind(String(info.uid || row.uid), roomId, title, currentStatus, observedAt, observedAt, row.id));
    if (previousStatus === null || previousStatus === currentStatus) continue;
    const transitionKey = `${row.id}:${previousStatus}:${currentStatus}:${Math.floor(Date.parse(observedAt) / 60000)}`;
    const message = formatTransitionMessage({ status: currentStatus, uname, title, roomId, format: settings.format });
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO monitor_transitions
      (transition_key, monitor_id, previous_status, current_status, title, room_id, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(transitionKey, row.id, previousStatus, currentStatus, title, roomId, observedAt));
    const shouldNotify = currentStatus === 1 ? settings.notify_start : settings.notify_end;
    if (shouldNotify) {
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO outbox
        (transition_key, target_id, message, format, status, attempts, next_attempt_at)
        SELECT ?, id, ?, ?, 'pending', 0, ? FROM targets WHERE enabled=1`)
        .bind(transitionKey, message, settings.format, observedAt));
    }
  }
  if (statements.length) await env.DB.batch(statements);
}

async function markBatchError(rows, error, env) {
  if (!rows.length) return;
  const timestamp = nowIso();
  const statements = rows.map(row => env.DB.prepare('UPDATE monitors SET last_checked_at=?, last_error=?, updated_at=? WHERE id=?')
    .bind(timestamp, error.slice(0, 300), timestamp, row.id));
  for (const group of chunk(statements, 50)) await env.DB.batch(group);
}

async function advanceScan(env, cursor, processed) {
  await env.DB.prepare('UPDATE job_state SET scan_cursor=?, scan_processed=scan_processed+? WHERE id=1').bind(cursor, processed).run();
  return queryOne(env, 'SELECT * FROM job_state WHERE id=1');
}

async function finishScan(env, interval, checked) {
  const next = new Date(Date.now() + interval * 60_000).toISOString();
  await env.DB.prepare(`UPDATE job_state SET scan_active=0, scan_cursor=0, scan_processed=0,
    next_check_at=?, last_finished_at=?, last_checked_count=?, last_error=NULL WHERE id=1`)
    .bind(next, nowIso(), checked).run();
}

async function processOutbox(env, format) {
  const rows = await env.DB.prepare(`
    SELECT o.id, o.message, o.format, o.attempts, t.type, t.target_id
    FROM outbox o JOIN targets t ON t.id=o.target_id
    WHERE o.status='pending' AND o.next_attempt_at<=? AND t.enabled=1
    ORDER BY o.id LIMIT ?
  `).bind(nowIso(), MAX_OUTBOX_SENDS_PER_RUN).all();
  const qqConfig = await getQQConfig(env);
  if (!rows.results?.length || !qqConfig.appId || !qqConfig.clientSecret) return;
  let token;
  try { token = await getAccessToken(env, qqConfig); } catch (error) {
    await markOutboxFailure(rows.results, publicError(error), env);
    return;
  }
  for (const row of rows.results) {
    try {
      let response = await sendQQ(token, row.type, row.target_id, row.message, row.format || format);
      if (response.status === 401) {
        token = await getAccessToken(env, qqConfig, true);
        response = await sendQQ(token, row.type, row.target_id, row.message, row.format || format);
      }
      if (!response.ok) throw new Error(`QQ API HTTP ${response.status}`);
      await env.DB.prepare(`UPDATE outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?`).bind(nowIso(), row.id).run();
    } catch (error) {
      await markOutboxFailure([row], publicError(error), env);
    }
  }
}

async function markOutboxFailure(rows, error, env) {
  for (const row of rows) {
    const attempts = Number(row.attempts || 0) + 1;
    const status = attempts >= 8 ? 'failed' : 'pending';
    const next = new Date(Date.now() + retryDelaySeconds(attempts) * 1000).toISOString();
    await env.DB.prepare(`UPDATE outbox SET status=?, attempts=?, next_attempt_at=?, last_error=? WHERE id=?`)
      .bind(status, attempts, next, error.slice(0, 300), row.id).run();
  }
}

async function getAccessToken(env, qqConfig = null, force = false) {
  const config = qqConfig || await getQQConfig(env);
  if (!config.appId || !config.clientSecret) throw new Error('QQ 凭证未配置');
  const key = String(config.appId);
  const cached = tokenCache.get(key);
  if (!force && cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const response = await fetch(`${QQ_API}/app/getAppAccessToken`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) throw new Error(`获取 QQ AccessToken 失败 HTTP ${response.status}`);
  tokenCache.set(key, { token: payload.access_token, expiresAt: Date.now() + Number(payload.expires_in || 7200) * 1000 });
  return payload.access_token;
}

async function sendQQ(token, type, targetId, message, format) {
  const path = type === 'group' ? `/v2/groups/${encodeURIComponent(targetId)}/messages` : `/v2/users/${encodeURIComponent(targetId)}/messages`;
  const body = format === 'markdown' ? { msg_type: 2, markdown: { content: message } } : { msg_type: 0, content: message };
  return fetch(`${QQ_API}${path}`, {
    method: 'POST', headers: { Authorization: `QQBot ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function nowIso() { return new Date().toISOString(); }

function adminHtml() {
  if (htmlCache) return htmlCache;
  htmlCache = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>B站直播监控</title><style>
  :root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#172033;background:#f4f6fa}body{max-width:1100px;margin:0 auto;padding:28px 18px}h1{margin:0 0 6px;font-size:26px}h2{font-size:18px;margin:0 0 14px}.muted{color:#667085;font-size:13px}.bar,.panel{background:#fff;border:1px solid #dfe4ec;border-radius:8px;padding:16px;margin:14px 0}.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bar input{flex:1;min-width:240px}input,select,button{font:inherit;padding:9px 10px;border:1px solid #c9d1dd;border-radius:6px}button{background:#1d5fd1;color:#fff;border:0;cursor:pointer}button.secondary{background:#eef3fb;color:#1d5fd1}button.danger{background:#c93434}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:760px){.grid{grid-template-columns:1fr}}form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}form input,form select{min-width:120px;flex:1}.row{display:flex;justify-content:space-between;gap:12px;align-items:center;border-top:1px solid #edf0f4;padding:10px 0}.row:first-child{border-top:0}.pill{font-size:12px;padding:3px 7px;border-radius:99px;background:#eef3fb}.live{background:#e7f7ee;color:#087443}.off{background:#f0f2f5;color:#667085}.error{color:#b42318;font-size:12px}.actions{display:flex;gap:6px}.status{white-space:pre-wrap;background:#101828;color:#e6edf7;border-radius:6px;padding:10px;font-size:12px}
  </style></head><body><h1>B站直播监控</h1><div class="muted">Cloudflare Workers + D1 · 管理密钥只保存在本浏览器会话</div>
  <div class="bar"><input id="key" type="password" placeholder="首次打开设置密码，之后用于登录"><button onclick="loginOrSetup()">设置/登录</button><button class="secondary" onclick="loadAll()">刷新</button><button class="secondary" onclick="manualCheck()">立即检查</button></div>
  <div id="status" class="status">尚未加载</div><div class="grid"><section class="panel"><h2>监控对象</h2><form onsubmit="addMonitor(event)"><select id="mtype"><option value="room">直播间号</option><option value="uid">B站 UID</option></select><input id="mid" required placeholder="ID"><input id="mlabel" placeholder="备注"><button>添加</button></form><div id="monitors"></div></section>
  <section class="panel"><h2>通知目标</h2><form onsubmit="addTarget(event)"><select id="ttype"><option value="private">QQ 私聊</option><option value="group">QQ群聊</option></select><input id="tid" required placeholder="OpenID"><input id="tlabel" placeholder="备注"><button>添加</button></form><div id="targets"></div></section></div>
  <section class="panel"><h2>设置</h2><form onsubmit="saveSettings(event)"><label>间隔 <input id="interval" type="number" min="1" max="60" value="1"> 分钟</label><label><input id="start" type="checkbox" checked> 开播</label><label><input id="end" type="checkbox" checked> 下播</label><select id="format"><option value="text">文本</option><option value="markdown">Markdown</option></select><button>保存设置</button></form></section>
  <section class="panel"><h2>QQ机器人</h2><form onsubmit="saveQQ(event)"><input id="appid" placeholder="AppID" required><input id="secret" type="password" placeholder="ClientSecret（留空保留原值）"><button>保存QQ配置</button></form><div class="muted">ClientSecret 会保存到 D1，不会在页面回显。</div></section>
  <script>
  const $=id=>document.getElementById(id);const sessionName='bili-live-admin-session';function token(){return sessionStorage.getItem(sessionName)||''}function headers(){const t=token();return {'Authorization':t?'Bearer '+t:'','Content-Type':'application/json'}}async function authInfo(){const r=await fetch('/api/auth/status');return r.json()}async function loginOrSetup(){const password=$('key').value;if(password.length<12){alert('密码至少需要12个字符');return}try{const info=await authInfo();const path=info.configured?'/api/auth/login':'/api/auth/setup';const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});const d=await r.json();if(!r.ok)throw Error(d.error||'认证失败');sessionStorage.setItem(sessionName,d.token);$('key').value='';loadAll()}catch(e){alert(e.message)}}async function api(path,opt={}){const r=await fetch(path,{...opt,headers:{...headers(),...(opt.headers||{})}});const d=await r.json().catch(()=>({error:r.statusText}));if(!r.ok)throw Error(d.error||'请求失败');return d}function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}async function loadAll(){try{const info=await authInfo();if(!token()){ $('status').textContent=info.configured?'请输入管理员密码后点击“设置/登录”':'首次使用，请设置管理员密码后点击“设置/登录”';return}const [s,m,t,set]=await Promise.all([api('/api/status'),api('/api/monitors'),api('/api/targets'),api('/api/settings')]);$('status').textContent=JSON.stringify(s,null,2);$('monitors').innerHTML=m.monitors.map(x=>'<div class="row"><div><b>'+esc(x.label||x.source_id)+'</b> <span class="pill">'+esc(x.type)+'</span><div class="muted">UID '+esc(x.uid)+' · 房间 '+esc(x.room_id||'未解析')+'</div></div><div class="actions"><span class="pill '+(x.live_status===1?'live':x.live_status===0?'off':'')+'">'+(x.live_status===1?'直播中':x.live_status===0?'未开播':'未检查')+'</span><button class="danger" onclick="delItem(\'/api/monitors/'+x.id+'\')">删除</button></div></div>').join('')||'<span class="muted">暂无监控</span>';$('targets').innerHTML=t.targets.map(x=>'<div class="row"><div><b>'+esc(x.label||x.target_id)+'</b><div class="muted">'+esc(x.type)+' · '+esc(x.target_id)+'</div></div><button class="danger" onclick="delItem(\'/api/targets/'+x.id+'\')">删除</button></div>').join('')||'<span class="muted">暂无目标</span>';$('interval').value=set.interval_minutes;$('start').checked=set.notify_start;$('end').checked=set.notify_end;$('format').value=set.format}catch(e){$('status').textContent='错误：'+e.message}}async function addMonitor(e){e.preventDefault();try{await api('/api/monitors',{method:'POST',body:JSON.stringify({type:$('mtype').value,id:$('mid').value,label:$('mlabel').value})});$('mid').value='';$('mlabel').value='';loadAll()}catch(e){alert(e.message)}}async function addTarget(e){e.preventDefault();try{await api('/api/targets',{method:'POST',body:JSON.stringify({type:$('ttype').value,id:$('tid').value,label:$('tlabel').value})});$('tid').value='';$('tlabel').value='';loadAll()}catch(e){alert(e.message)}}async function saveSettings(e){e.preventDefault();try{await api('/api/settings',{method:'PUT',body:JSON.stringify({interval_minutes:Number($('interval').value),notify_start:$('start').checked,notify_end:$('end').checked,format:$('format').value})});loadAll()}catch(e){alert(e.message)}}async function delItem(path){if(!confirm('确认删除？'))return;try{await api(path,{method:'DELETE'});loadAll()}catch(e){alert(e.message)}}async function manualCheck(){try{await api('/api/check',{method:'POST'});loadAll()}}loadAll();setInterval(loadAll,30000);
  </script><script>async function saveQQ(e){e.preventDefault();try{await api('/api/qq-config',{method:'PUT',body:JSON.stringify({app_id:$('appid').value.trim(),client_secret:$('secret').value})});$('secret').value='';alert('QQ配置已保存')}catch(e){alert(e.message)}}const previousLoadAll=loadAll;loadAll=async function(){await previousLoadAll();if(token()){try{const q=await api('/api/qq-config');$('appid').value=q.app_id||''}catch(e){}}};loadAll();</script></body></html>`;
  return htmlCache;
}
