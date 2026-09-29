/* Private voice station: Cloudflare D1 + private R2; inference stays on the Mac. */
import {D1AudioStore, D1_MAX_AUDIO_BYTES, D1_AUDIO_QUOTA_BYTES, StorageError} from './d1_audio.js';
const COOKIE = 'voice_station_session';
const encoder = new TextEncoder();
const MAX_UPLOAD = 64 * 1024 * 1024;
const SESSION_SECONDS = 7 * 24 * 3600;
const ANONYMOUS_SECONDS = 1800;
const PBKDF2_ITERATIONS = 100000;

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const nowSeconds = () => Math.floor(Date.now() / 1000);
export function randomToken(bytes = 32) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function hexBytes(hex) {
  if (typeof hex !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(hex)) fail(400, 'invalid_hex', '格式不正确');
  return Uint8Array.from(hex.match(/../g).map(x => parseInt(x, 16)));
}
const toHex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
export async function sha256(value) { return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value))); }
export async function passwordHash(password, salt, iterations = PBKDF2_ITERATIONS) {
  if (iterations !== PBKDF2_ITERATIONS) fail(500, 'password_config', '账户配置需要维护');
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: hexBytes(salt), iterations}, key, 256));
}
export function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
}
export function validateText(input, maxLength = 300) {
  if (typeof input !== 'string') fail(400, 'invalid_text', '请输入要生成的文字');
  const text = input.trim();
  if (!text || [...text].length > maxLength) fail(400, 'invalid_text', `文字长度应为 1～${maxLength} 字`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail(400, 'invalid_text', '文字含有不支持的控制字符');
  return text;
}
export function validateRequestKey(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(key)) fail(400, 'invalid_request_key', '请求标识格式不正确');
  return key;
}
export function validateWorkerId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(value)) fail(400, 'invalid_worker_id', '生成服务标识格式不正确');
  return value;
}
export function requireSameOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin !== new URL(request.url).origin) fail(403, 'origin_rejected', '请从本站页面操作');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) fail(403, 'origin_rejected', '请从本站页面操作');
}
function cookieValue(request) {
  const cookie = request.headers.get('Cookie') || '';
  for (const item of cookie.split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === COOKIE) return /^[a-f0-9]{64}$/.test(value.join('=')) ? value.join('=') : null;
  }
  return null;
}
function sessionCookie(token, seconds) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}
function securityHeaders(headers = new Headers()) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Frame-Options', 'DENY');
  return headers;
}
function json(value, status = 200, extra = {}) {
  const headers = securityHeaders(new Headers(extra));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Vary', 'Cookie');
  return new Response(JSON.stringify(value), {status, headers});
}
async function readJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, 'json_required', '请使用 JSON 请求');
  if (Number(request.headers.get('Content-Length') || 0) > 8192) fail(413, 'body_too_large', '请求内容过长');
  let body;
  try {
    const raw = await request.text();
    if (encoder.encode(raw).length > 8192) fail(413, 'body_too_large', '请求内容过长');
    body = JSON.parse(raw);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(400, 'invalid_json', 'JSON 格式不正确');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json', '请求内容格式不正确');
  return body;
}
const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
const row = (db, sql, ...args) => statement(db, sql, ...args).first();
const rows = async (db, sql, ...args) => (await statement(db, sql, ...args).all()).results || [];

async function findSession(request, db, now) {
  const token = cookieValue(request);
  if (!token) return null;
  return row(db, `SELECT s.*, u.username, u.display_name, u.active, u.role
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND (s.user_id IS NULL OR (u.active = 1 AND u.deleted_at IS NULL))`, await sha256(token), now);
}
async function createSession(db, userId, now) {
  const token = randomToken();
  const session = {token_hash: await sha256(token), user_id: userId, csrf_token: randomToken(), created_at: now,
    expires_at: now + (userId ? SESSION_SECONDS : ANONYMOUS_SECONDS)};
  await statement(db, `INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES(?1,?2,?3,?4,?5)`,
    session.token_hash, userId, session.csrf_token, now, session.expires_at).run();
  return {session, cookie: sessionCookie(token, session.expires_at - now)};
}
function requireUser(session) {
  if (!session?.user_id) fail(401, 'login_required', '请先登录');
  return session.user_id;
}
function requireCsrf(request, session) {
  requireSameOrigin(request);
  if (!session || !secureEqual(request.headers.get('X-CSRF-Token'), session.csrf_token)) fail(403, 'csrf_rejected', '页面已过期，请刷新后重试');
}
function publicUser(session) {
  return session?.user_id ? {id: session.user_id, username: session.username, display_name: session.display_name, role: session.role} : null;
}
async function workerStatus(env, now) {
  const state = await row(env.DB, 'SELECT * FROM worker_state WHERE id=1');
  const fresh = state && state.last_heartbeat >= now - Number(env.WORKER_OFFLINE_SECONDS || 90);
  return {ready: Boolean(fresh && state.ready), message: fresh ? state.message : '生成电脑暂时离线，已提交的请求会保留排队',
    last_heartbeat: state?.last_heartbeat || null};
}
export function publicJob(job) {
  return {id: job.id, voice_id: job.voice_id, voice_name: job.voice_name || job.voice_id, text: job.text,
    status: job.status, cancel_requested: Boolean(job.cancel_requested), queue_position: job.queue_position ?? null,
    created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at,
    duration_seconds: job.duration_seconds, error: job.error,
    phase: job.status === 'running' ? (job.phase || 'generating') : job.status, completed_segments: job.completed_segments || 0,
    total_segments: job.total_segments || 0, elapsed_seconds: job.elapsed_seconds || 0,
    deleted_at: job.deleted_at, restore_until: job.deleted_at && !job.reclaimed_at ? job.deleted_at + 604800 : null,
    audio_url: job.status === 'completed' && job.audio_key ? `/api/jobs/${job.id}/audio` : null};
}
export const SQL_OWN_JOBS = `SELECT j.*, v.name AS voice_name,
  CASE WHEN j.status='queued' THEN
    (SELECT count(*) FROM jobs WHERE status='running') +
    (SELECT count(*) FROM jobs q WHERE q.status='queued' AND q.id<j.id) + 1
    WHEN j.status='running' THEN 1 ELSE NULL END AS queue_position
  FROM jobs j JOIN voices v ON v.id=j.voice_id
  WHERE j.user_id=?1 AND j.deleted_at IS NULL AND j.status IN ('queued','running') ORDER BY j.id DESC`;
async function ownJob(env, userId, id) {
  const job = await row(env.DB, 'SELECT j.*, v.name AS voice_name FROM jobs j JOIN voices v ON v.id=j.voice_id WHERE j.id=?1 AND j.user_id=?2 AND j.deleted_at IS NULL', id, userId);
  if (!job) fail(404, 'job_not_found', '找不到这个请求');
  return job;
}
export function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(size) || size < 1) fail(416, 'range_invalid', '音频范围不正确');
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) fail(416, 'range_invalid', '音频范围不正确');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) fail(416, 'range_invalid', '音频范围不正确');
    end = Math.min(end, size - 1);
  }
  return {offset: start, length: end - start + 1};
}
async function streamAudio(request, env, key, filename) {
  const metadata = await env.AUDIO.head(key);
  if (!metadata) fail(404, 'audio_not_found', '暂时找不到音频');
  let range;
  try { range = parseRange(request.headers.get('Range'), metadata.size); }
  catch (error) {
    if (error.status === 416) return json({error: {code: error.code, message: error.message}}, 416, {'Content-Range': `bytes */${metadata.size}`});
    throw error;
  }
  const headers = securityHeaders(new Headers({'Content-Type': metadata.httpMetadata?.contentType || 'audio/wav',
    'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes', 'Vary': 'Cookie',
    'Content-Length': String(range?.length ?? metadata.size), 'ETag': metadata.httpEtag}));
  if (range) headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
  if (new URL(request.url).searchParams.get('download') === '1') headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  if (request.method === 'HEAD') return new Response(null, {status: range ? 206 : 200, headers});
  const object = await env.AUDIO.get(key, range ? {range} : undefined);
  if (!object) fail(404, 'audio_not_found', '暂时找不到音频');
  return new Response(object.body, {status: range ? 206 : 200, headers});
}

async function register(request, env, session, now) {
  requireCsrf(request, session);
  const body = await readJson(request);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const ipHash = await sha256(`voice-station-register:${ip}`);
  const window = Math.floor(now / 600) * 600;
  const rate = await row(env.DB, `INSERT INTO login_rate(ip_hash,window_start,attempts) VALUES(?1,?2,1)
    ON CONFLICT(ip_hash,window_start) DO UPDATE SET attempts=attempts+1 RETURNING attempts`, ipHash, window);
  if (rate.attempts > 10) fail(429, 'register_rate_limited', '注册尝试过多，请十分钟后再试');
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,39}$/.test(username)) fail(400, 'invalid_username', '用户名为 3～40 位字母、数字、下划线、点或短横线');
  checkPassword(body.password);
  if ('role' in body && body.role !== 'user') fail(400, 'invalid_role', '注册只能创建普通用户');
  if (await row(env.DB, 'SELECT id FROM users WHERE username=?1 COLLATE NOCASE', username)) fail(409, 'username_exists', '用户名已存在，请登录或换一个用户名');
  const id = crypto.randomUUID(), salt = randomToken(16), hash = await passwordHash(body.password, salt);
  const token = randomToken(), csrf = randomToken();
  try {
    await env.DB.batch([
      statement(env.DB, `INSERT INTO users(id,username,display_name,password_salt,password_hash,role,active,created_at)
        VALUES(?1,?2,?2,?3,?4,'user',1,?5)`, id,username,salt,hash,now),
      statement(env.DB, 'INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES(?1,?2,?3,?4,?5)', await sha256(token),id,csrf,now,now+SESSION_SECONDS),
      statement(env.DB, 'DELETE FROM sessions WHERE token_hash=?1 OR expires_at<?2', session.token_hash,now),
      statement(env.DB, 'DELETE FROM login_rate WHERE window_start<?1', now-1200),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: users.username/.test(error.message)) fail(409, 'username_exists', '用户名已存在，请登录或换一个用户名');
    throw error;
  }
  return json({authenticated:true,user:{id,username,display_name:username,role:'user'},csrf_token:csrf},201,{'Set-Cookie':sessionCookie(token,SESSION_SECONDS)});
}

async function login(request, env, session, now) {
  requireCsrf(request, session);
  const body = await readJson(request);
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const ipHash = await sha256(`voice-station-rate:${ip}`);
  const window = Math.floor(now / 600) * 600;
  const rate = await row(env.DB, `INSERT INTO login_rate(ip_hash,window_start,attempts) VALUES(?1,?2,1)
    ON CONFLICT(ip_hash,window_start) DO UPDATE SET attempts=attempts+1 RETURNING attempts`, ipHash, window);
  if (rate.attempts > 20) fail(429, 'login_rate_limited', '登录尝试过多，请十分钟后再试');
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || username.length > 80 || password.length < 1 || password.length > 256) fail(401, 'invalid_credentials', '用户名或密码不正确');
  const user = await row(env.DB, 'SELECT * FROM users WHERE username=?1 COLLATE NOCASE AND active=1 AND deleted_at IS NULL', username);
  // Equal hashing work for missing users; no password or raw IP is stored in logs.
  const hash = await passwordHash(password, user?.password_salt || '00'.repeat(16), user?.password_iterations || PBKDF2_ITERATIONS);
  if (!user || !secureEqual(hash, user.password_hash)) fail(401, 'invalid_credentials', '用户名或密码不正确');
  const created = await createSession(env.DB, user.id, now);
  await env.DB.batch([
    statement(env.DB, 'DELETE FROM sessions WHERE token_hash=?1', session.token_hash),
    statement(env.DB, 'DELETE FROM sessions WHERE expires_at<?1', now),
    statement(env.DB, 'DELETE FROM login_rate WHERE window_start<?1', now - 1200),
  ]);
  return json({authenticated: true, user: {id: user.id, username: user.username, display_name: user.display_name, role: user.role}, csrf_token: created.session.csrf_token}, 200, {'Set-Cookie': created.cookie});
}

export const SQL_CLAIM = `UPDATE jobs SET status='running', started_at=?1, finished_at=NULL,
  worker_id=?2, lease_token=?3, lease_expires_at=?4, attempt=attempt+1,
  uploaded_audio_key=NULL, audio_key=NULL, error=NULL, duration_seconds=NULL,
  phase='loading',completed_segments=0,total_segments=0,elapsed_seconds=0
  WHERE id=(SELECT id FROM jobs WHERE status='queued' AND deleted_at IS NULL AND cancel_requested=0 ORDER BY id LIMIT 1)
    AND NOT EXISTS(SELECT 1 FROM jobs WHERE status='running') RETURNING *`;
export const SQL_RECOVER = `UPDATE jobs SET
  status=CASE WHEN cancel_requested=1 OR deleted_at IS NOT NULL THEN 'cancelled' ELSE 'queued' END,
  finished_at=CASE WHEN cancel_requested=1 OR deleted_at IS NOT NULL THEN ?1 ELSE NULL END,
  started_at=NULL, worker_id=NULL, lease_token=NULL, lease_expires_at=NULL,
  uploaded_audio_key=NULL, audio_key=NULL, error=NULL
  WHERE status='running' AND worker_id=?2 AND lease_expires_at<?1 RETURNING id,status`;
export function audioKey(id, leaseToken) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1 || !/^[a-f0-9]{64}$/.test(leaseToken || '')) fail(400, 'invalid_lease', '生成租约格式不正确');
  return `jobs/${Number(id)}/${leaseToken}.wav`;
}
async function requireLease(env, id, token) {
  audioKey(id, token);
  const job = await row(env.DB, "SELECT * FROM jobs WHERE id=?1 AND status='running' AND lease_token=?2", id, token);
  if (!job) fail(409, 'lease_lost', '该生成任务的租约已失效');
  return job;
}
async function workerApi(request, env, url, now) {
  const authorization = request.headers.get('Authorization') || '';
  if (!env.WORKER_TOKEN || !secureEqual(authorization, `Bearer ${env.WORKER_TOKEN}`)) fail(401, 'worker_auth_required', '生成服务认证失败');
  const path = url.pathname.slice('/api/worker'.length);
  const leaseSeconds = Number(env.LEASE_SECONDS || 300);
  if (path === '/heartbeat' && request.method === 'POST') {
    const body = await readJson(request); const workerId = validateWorkerId(body.worker_id);
    const message = typeof body.message === 'string' ? body.message.slice(0, 200) : '';
    await statement(env.DB, `INSERT INTO worker_state(id,worker_id,last_heartbeat,ready,message) VALUES(1,?1,?2,?3,?4)
      ON CONFLICT(id) DO UPDATE SET worker_id=excluded.worker_id,last_heartbeat=excluded.last_heartbeat,ready=excluded.ready,message=excluded.message`,
      workerId, now, body.ready === true ? 1 : 0, message).run();
    return json({ok: true, lease_seconds: leaseSeconds});
  }
  if (path === '/recover' && request.method === 'POST') {
    const body = await readJson(request); const workerId = validateWorkerId(body.worker_id);
    return json({recovered: await rows(env.DB, SQL_RECOVER, now, workerId)});
  }
  if (path === '/claim' && ['GET', 'POST'].includes(request.method)) {
    const body = request.method === 'POST' ? await readJson(request) : {worker_id: url.searchParams.get('worker_id')};
    const workerId = validateWorkerId(body.worker_id);
    const token = randomToken();
    const job = await row(env.DB, SQL_CLAIM, now, workerId, token, now + leaseSeconds);
    if (!job) {
      const running = await row(env.DB, "SELECT lease_expires_at FROM jobs WHERE status='running' LIMIT 1");
      return json({job: null, unavailable: running ? (running.lease_expires_at < now ? 'stale_lease' : 'busy') : null, lease_seconds: leaseSeconds});
    }
    const voice = await row(env.DB, 'SELECT * FROM voices WHERE id=?1', job.voice_id);
    return json({job: {...job, reference_text: voice.reference_text, reference_seconds: voice.reference_seconds,
      reference_url: `/api/worker/voices/${encodeURIComponent(job.voice_id)}/reference`}, lease_seconds: leaseSeconds});
  }
  const referenceMatch = /^\/voices\/([^/]+)\/reference$/.exec(path);
  if (referenceMatch && request.method === 'PUT') {
    const voiceId = decodeURIComponent(referenceMatch[1]);
    const voice = await row(env.DB, 'SELECT reference_key,reference_text FROM voices WHERE id=?1', voiceId);
    if (typeof voice?.reference_key !== 'string' || !voice.reference_key.trim() || typeof voice.reference_text !== 'string' || !voice.reference_text.trim()) fail(404, 'voice_not_found', '找不到这个声线');
    const length = Number(request.headers.get('Content-Length'));
    if (!Number.isSafeInteger(length) || length < 44 || length > 2 * 1024 * 1024) fail(413, 'reference_size_invalid', '原声样本须为 44 字节～2 MiB，并提供 Content-Length');
    if (!['audio/wav','audio/x-wav','audio/wave'].includes((request.headers.get('Content-Type') || '').split(';')[0].toLowerCase())) fail(415, 'wav_required', '请上传 WAV 原声样本');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length !== length || bytes.length > 2 * 1024 * 1024) fail(413, 'reference_size_invalid', '原声样本大小与请求声明不一致');
    if (String.fromCharCode(...bytes.slice(0,4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8,12)) !== 'WAVE') fail(400, 'invalid_wav', '原声样本不是标准 WAV 文件');
    const object = await env.AUDIO.put(voice.reference_key, bytes, {httpMetadata: {contentType: 'audio/wav'}, customMetadata: {voice_id: voiceId}});
    return json({ok: true, voice_id: voiceId, size: object.size, sha256: toHex(await crypto.subtle.digest('SHA-256', bytes))});
  }
  if (referenceMatch && ['GET', 'HEAD'].includes(request.method)) {
    const voice = await row(env.DB, 'SELECT reference_key FROM voices WHERE id=?1 AND available=1', decodeURIComponent(referenceMatch[1]));
    if (!voice?.reference_key) fail(404, 'voice_not_found', '找不到这个声线');
    return streamAudio(request, env, voice.reference_key, 'reference.wav');
  }
  const match = /^\/jobs\/([1-9]\d*)\/(heartbeat|audio|finish|release)$/.exec(path);
  if (!match) fail(404, 'not_found', '找不到这个接口');
  const id = Number(match[1]);
  if (match[2] === 'audio' && ['PUT', 'POST'].includes(request.method)) {
    const token = url.searchParams.get('lease_token');
    const job = await requireLease(env, id, token);
    if (job.cancel_requested || job.deleted_at) fail(409, 'cancel_requested', '这个请求已申请取消');
    const length = Number(request.headers.get('Content-Length'));
    const maxUpload = env.AUDIO_STORAGE === 'd1' ? D1_MAX_AUDIO_BYTES : MAX_UPLOAD;
    if (!Number.isSafeInteger(length) || length < 44 || length > maxUpload || !request.body) fail(413, 'audio_size_invalid', `音频应为 44 字节～${maxUpload/1024/1024} MiB，并提供 Content-Length`);
    if (!['audio/wav', 'audio/x-wav', 'audio/wave'].includes((request.headers.get('Content-Type') || '').split(';')[0].toLowerCase())) fail(415, 'wav_required', '请上传 WAV 音频');
    const key = audioKey(id, token);
    const object = await env.AUDIO.put(key, request.body, {httpMetadata: {contentType: 'audio/wav'}, customMetadata: {job_id: String(id), lease_token: token}});
    const saved = await row(env.DB, `UPDATE jobs SET uploaded_audio_key=?1 WHERE id=?2 AND status='running' AND lease_token=?3
      AND cancel_requested=0 AND deleted_at IS NULL RETURNING id`, key, id, token);
    if (!saved) fail(409, 'lease_lost', '上传期间请求被取消或租约已失效');
    return json({audio_key: key, size: object.size});
  }
  if (match[2] === 'heartbeat' && request.method === 'POST') {
    const body = await readJson(request); audioKey(id, body.lease_token);
    const phase = ['loading','generating','uploading','retrying'].includes(body.phase) ? body.phase : null;
    if ('phase' in body && !phase) fail(400,'invalid_progress','生成阶段不正确');
    const names=['completed_segments','total_segments','elapsed_seconds'];
    const hasProgress=names.some(name=>name in body);
    if(hasProgress && (names.some(name=>!Number.isSafeInteger(body[name]) || body[name]<0 || body[name]>1000000) || body.completed_segments>body.total_segments))
      fail(400,'invalid_progress','生成进度不正确');
    const total=hasProgress?body.total_segments:null,completed=hasProgress?body.completed_segments:null;
    const job = await row(env.DB, `UPDATE jobs SET lease_expires_at=?1,phase=coalesce(?4,phase),
      completed_segments=coalesce(?5,completed_segments),total_segments=coalesce(?6,total_segments),elapsed_seconds=coalesce(?7,elapsed_seconds) WHERE id=?2 AND status='running' AND lease_token=?3
      RETURNING cancel_requested,deleted_at,lease_expires_at`, now + leaseSeconds, id, body.lease_token, phase,completed,total,hasProgress?body.elapsed_seconds:null);
    if (!job) fail(409, 'lease_lost', '该生成任务的租约已失效');
    return json({cancel_requested: Boolean(job.cancel_requested || job.deleted_at), lease_expires_at: job.lease_expires_at});
  }
  if (match[2] === 'release' && request.method === 'POST') {
    const body = await readJson(request); audioKey(id, body.lease_token);
    // Caller must first confirm native inference has exited. Requeue keeps FIFO id.
    const released = await row(env.DB, `UPDATE jobs SET
      status=CASE WHEN cancel_requested=1 OR deleted_at IS NOT NULL THEN 'cancelled' ELSE 'queued' END,
      finished_at=CASE WHEN cancel_requested=1 OR deleted_at IS NOT NULL THEN ?1 ELSE NULL END,
      started_at=NULL, worker_id=NULL, lease_token=NULL, lease_expires_at=NULL,
      uploaded_audio_key=NULL, audio_key=NULL, duration_seconds=NULL, error=NULL
      WHERE id=?2 AND status='running' AND lease_token=?3 RETURNING id,status`, now, id, body.lease_token);
    if (!released) fail(409, 'lease_lost', '该生成任务的租约已失效');
    return json({job: released});
  }
  if (match[2] === 'finish' && request.method === 'POST') {
    const body = await readJson(request);
    const job = await requireLease(env, id, body.lease_token);
    if (!['completed', 'cancelled', 'failed'].includes(body.status)) fail(400, 'invalid_status', '结束状态不正确');
    const cancelled = Boolean(job.cancel_requested || job.deleted_at);
    let duration = null;
    if (body.status === 'completed' && !cancelled) {
      if (body.audio_key !== audioKey(id, body.lease_token) || body.audio_key !== job.uploaded_audio_key) fail(400, 'audio_not_uploaded', '请先上传当前任务的音频');
      const audio = await env.AUDIO.head(body.audio_key);
      if (!audio || audio.size < 44 || audio.size > MAX_UPLOAD) fail(400, 'audio_not_uploaded', '当前任务音频不存在或大小不正确');
      duration = Number(body.duration_seconds);
      if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) fail(400, 'invalid_duration', '音频时长不正确');
    }
    const error = body.status === 'failed' ? (typeof body.error === 'string' ? body.error.slice(0, 500) : '生成失败，请重新提交') : null;
    const finished = await row(env.DB, `UPDATE jobs SET
      status=CASE WHEN cancel_requested=1 OR deleted_at IS NOT NULL THEN 'cancelled' ELSE ?1 END,
      finished_at=?2, lease_expires_at=NULL,
      audio_key=CASE WHEN cancel_requested=0 AND deleted_at IS NULL AND ?1='completed' THEN uploaded_audio_key ELSE NULL END,
      duration_seconds=CASE WHEN cancel_requested=0 AND deleted_at IS NULL AND ?1='completed' THEN ?3 ELSE NULL END,
      error=CASE WHEN cancel_requested=0 AND deleted_at IS NULL AND ?1='failed' THEN ?4 ELSE NULL END
      WHERE id=?5 AND status='running' AND lease_token=?6 RETURNING id,status`,
      body.status, now, duration, error, id, body.lease_token);
    if (!finished) fail(409, 'lease_lost', '该生成任务的租约已失效');
    return json({job: finished});
  }
  fail(405, 'method_not_allowed', '请求方法不支持');
}

async function siteSettings(db) {
  const settings = await row(db, 'SELECT max_text_length,accepting_jobs,max_pending_jobs FROM site_settings WHERE id=1');
  return {...settings, accepting_jobs: Boolean(settings.accepting_jobs)};
}
const auditStatement = (db, session, now, action, target, detail = {}) => statement(db,
  'INSERT INTO admin_audit(actor_id,actor_name,action,target,detail,created_at) VALUES(?1,?2,?3,?4,?5,?6)',
  session.user_id, session.username, action, target, JSON.stringify(detail), now);
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail(400, 'invalid_password', '密码长度应为 8～128 位');
}
const RETENTION_SECONDS = 7 * 86400;
function audioQuota(env) {
  const value = Number(env.AUDIO_QUOTA_BYTES || 256 * 1024 * 1024);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value,D1_AUDIO_QUOTA_BYTES) : 256 * 1024 * 1024;
}
// Published unlinked historical samples are deliberately excluded: their ownership
// must be reviewed manually. Cleanup only handles known expired jobs and abandoned versions.
const RECLAIMABLE = `u.created_at<?1
  AND NOT EXISTS(SELECT 1 FROM voices v WHERE v.reference_key=u.object_key)
  AND NOT EXISTS(SELECT 1 FROM jobs j WHERE
    ((j.audio_key=u.object_key OR j.uploaded_audio_key=u.object_key)
      AND (j.deleted_at IS NULL OR j.deleted_at>=?1 OR j.status IN ('queued','running')))
    OR (j.status IN ('queued','running') AND u.object_key LIKE 'jobs/'||j.id||'/%'))
  AND (EXISTS(SELECT 1 FROM jobs j WHERE j.deleted_at<?1 AND j.status NOT IN ('queued','running')
       AND (j.audio_key=u.object_key OR j.uploaded_audio_key=u.object_key))
    OR NOT EXISTS(SELECT 1 FROM audio_objects o WHERE o.version_id=u.version_id))`;
async function cleanupCandidates(env,now) {
  if (env.AUDIO_STORAGE !== 'd1') return [];
  return rows(env.DB,`SELECT u.version_id,u.object_key AS key,u.size,
    CASE WHEN EXISTS(SELECT 1 FROM audio_objects o WHERE o.version_id=u.version_id)
      THEN 'expired_deleted_job' ELSE 'abandoned_version' END AS reason
    FROM audio_uploads u WHERE ${RECLAIMABLE} ORDER BY u.created_at LIMIT 100`,now-RETENTION_SECONDS);
}
async function storageStatus(env) {
  if (env.AUDIO_STORAGE !== 'd1') return {supported:false,accepting_jobs:true};
  const data = await row(env.DB,`SELECT coalesce(sum(size),0) used_bytes,
    coalesce(sum(CASE WHEN object_key LIKE 'references/%' THEN size ELSE 0 END),0) reference_bytes,
    coalesce(sum(CASE WHEN object_key LIKE 'jobs/%' THEN size ELSE 0 END),0) generated_bytes FROM audio_uploads`);
  const pending = await row(env.DB,"SELECT count(*) n FROM jobs WHERE status IN ('queued','running')");
  const reclaim = await row(env.DB,`SELECT coalesce(sum(u.size),0) n FROM audio_uploads u WHERE ${RECLAIMABLE}`,nowSeconds()-RETENTION_SECONDS);
  const quota = audioQuota(env), ratio=data.used_bytes/quota, reserved=pending.n*D1_MAX_AUDIO_BYTES;
  return {...data,quota_bytes:quota,ratio,level:ratio>=0.95?'critical':ratio>=0.85?'warning':ratio>=0.7?'notice':'normal',
    reclaimable_bytes:reclaim.n,reserved_pending_bytes:reserved,
    accepting_jobs:ratio<0.95 && data.used_bytes+reserved+D1_MAX_AUDIO_BYTES<=quota};
}
async function cleanupAudio(env,now,versions,session) {
  if (env.AUDIO_STORAGE !== 'd1') fail(409,'cleanup_unsupported','当前存储不支持此清理操作');
  if (!Array.isArray(versions) || versions.length<1 || versions.length>20 || versions.some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))
    fail(400,'invalid_cleanup','每次请选择 1～20 个有效回收项');
  const unique=[...new Set(versions)], commands=[];
  // Each eligibility check and all deletes happen in one D1 transaction; restore
  // cannot interleave between the protection check and deletion.
  const eligible=`SELECT u.version_id FROM audio_uploads u WHERE u.version_id IN (${unique.map((_,i)=>'?'+(i+2)).join(',')}) AND ${RECLAIMABLE}`;
  for (const table of ['audio_objects','audio_chunks','audio_uploads']) {
    commands.push(statement(env.DB,`DELETE FROM ${table} WHERE version_id IN (${eligible})`,now-RETENTION_SECONDS,...unique));
  }
  commands.push(statement(env.DB,`UPDATE jobs SET reclaimed_at=?1,audio_key=NULL,uploaded_audio_key=NULL
    WHERE deleted_at<?2 AND status NOT IN ('queued','running') AND reclaimed_at IS NULL
      AND (audio_key IS NOT NULL OR uploaded_audio_key IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM audio_uploads u WHERE u.object_key=jobs.audio_key OR u.object_key=jobs.uploaded_audio_key)`,now,now-RETENTION_SECONDS));
  if (session) commands.push(auditStatement(env.DB,session,now,'storage.cleanup','audio',{version_ids:unique}));
  const results=await env.DB.batch(commands);
  const reclaimed=Number(results[2].meta?.changes || 0);
  return {ok:true,reclaimed_versions:reclaimed,storage:await storageStatus(env)};
}

async function adminApi(request, env, url, now, session) {
  if (session.role !== 'admin') fail(403, 'admin_required', '仅管理员可以访问后台');
  const path = url.pathname.slice('/api/admin'.length);
  if (path === '/storage/cleanup-preview' && request.method === 'GET') return json({candidates:await cleanupCandidates(env,now),storage:await storageStatus(env)});
  if (path === '/storage/cleanup' && request.method === 'POST') {
    const body=await readJson(request);
    return json(await cleanupAudio(env,now,body.version_ids,session));
  }
  if (path === '/overview' && request.method === 'GET') {
    const [users, voices, settings, worker, counts, audit] = await Promise.all([
      rows(env.DB, `SELECT u.id,u.username,u.display_name,u.role,u.active,u.deleted_at,u.created_at,
        (SELECT count(*) FROM jobs j WHERE j.user_id=u.id AND j.deleted_at IS NULL) AS job_count FROM users u ORDER BY u.created_at,u.id`),
      rows(env.DB, 'SELECT id,name,available,hidden,reference_seconds FROM voices ORDER BY name'),
      siteSettings(env.DB), workerStatus(env, now),
      row(env.DB, `SELECT coalesce(sum(status='queued'),0) queued,coalesce(sum(status='running'),0) running,
        coalesce(sum(status='completed'),0) completed,coalesce(sum(status='failed'),0) failed FROM jobs WHERE deleted_at IS NULL`),
      rows(env.DB, 'SELECT id,actor_name,action,target,detail,created_at FROM admin_audit ORDER BY id DESC LIMIT 100')
    ]);
    return json({users: users.map(u => ({...u, active: Boolean(u.active)})),
      voices: voices.map(v => ({...v, available: Boolean(v.available), hidden: Boolean(v.hidden)})), settings, worker, counts, audit, storage: await storageStatus(env)});
  }
  if (path === '/jobs' && request.method === 'GET') {
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1) fail(400, 'invalid_cursor', '翻页位置不正确');
    const jobs = await rows(env.DB, `SELECT j.id,u.username,v.name AS voice_name,j.status,j.created_at,j.cancel_requested
      FROM jobs j JOIN users u ON u.id=j.user_id JOIN voices v ON v.id=j.voice_id
      WHERE j.id<?1 AND j.deleted_at IS NULL ORDER BY j.id DESC LIMIT 51`, before);
    const page = jobs.slice(0,50);
    return json({jobs: page.map(j => ({...j, cancel_requested: Boolean(j.cancel_requested)})), next_before: jobs.length>50 ? page.at(-1).id : null});
  }
  if (path === '/users' && request.method === 'POST') {
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : username;
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,39}$/.test(username)) fail(400, 'invalid_username', '用户名为 3～40 位字母、数字、下划线、点或短横线');
    if (!displayName || [...displayName].length > 40) fail(400, 'invalid_name', '显示名称应为 1～40 字');
    if ('role' in body && body.role !== 'user') fail(400, 'invalid_role', '只能创建普通用户');
    checkPassword(body.password);
    if (await row(env.DB, 'SELECT id FROM users WHERE username=?1 COLLATE NOCASE', username)) fail(409, 'username_exists', '用户名已存在（包括已删除用户），可以恢复原账号');
    const id = crypto.randomUUID(), salt = randomToken(16), hash = await passwordHash(body.password, salt);
    try {
      await env.DB.batch([
        statement(env.DB, `INSERT INTO users(id,username,display_name,password_salt,password_hash,created_at) VALUES(?1,?2,?3,?4,?5,?6)`, id, username, displayName, salt, hash, now),
        auditStatement(env.DB, session, now, 'user.create', id, {username, display_name: displayName})
      ]);
    } catch(error) {
      if (/UNIQUE constraint failed: users.username/.test(error.message)) fail(409, 'username_exists', '用户名已存在');
      throw error;
    }
    return json({ok: true, user: {id, username, display_name: displayName, active: true, role: 'user'}}, 201);
  }
  const userMatch = /^\/users\/([a-zA-Z0-9_-]{1,100})(\/restore)?$/.exec(path);
  if (userMatch && ['PATCH','DELETE','POST'].includes(request.method)) {
    const user = await row(env.DB, 'SELECT id,username,role,deleted_at FROM users WHERE id=?1', userMatch[1]);
    if (!user) fail(404, 'user_not_found', '找不到用户');
    if (user.role === 'admin' || user.id === session.user_id) fail(409, 'protected_admin', '管理员账户不能在此停用、删除或重置');
    let sql, args, action, detail = {}, revoke = false, cancel = false;
    if (userMatch[2] && request.method === 'POST') {
      if (!user.deleted_at) fail(409, 'user_not_deleted', '用户未删除');
      sql = 'UPDATE users SET deleted_at=NULL,active=0 WHERE id=?1'; args = [user.id]; action = 'user.restore';
    } else if (!userMatch[2] && request.method === 'DELETE') {
      sql = 'UPDATE users SET active=0,deleted_at=?1 WHERE id=?2'; args = [now,user.id]; action = 'user.delete'; revoke = cancel = true;
    } else if (!userMatch[2] && request.method === 'PATCH') {
      if (user.deleted_at) fail(409, 'user_deleted', '请先恢复用户');
      const body = await readJson(request);
      if ('password' in body && !('active' in body)) {
        checkPassword(body.password); const salt = randomToken(16), hash = await passwordHash(body.password, salt);
        sql = 'UPDATE users SET password_salt=?1,password_hash=?2,password_iterations=100000 WHERE id=?3';
        args = [salt,hash,user.id]; action = 'user.password_reset'; revoke = true;
      } else if (typeof body.active === 'boolean' && !('password' in body)) {
        sql = 'UPDATE users SET active=?1 WHERE id=?2'; args = [body.active ? 1 : 0,user.id];
        action = body.active ? 'user.enable' : 'user.disable'; revoke = cancel = !body.active;
      } else fail(400, 'invalid_user_update', '请选择启停用户或重置密码');
    } else fail(405, 'method_not_allowed', '请求方法不支持');
    const changes = [statement(env.DB, sql, ...args)];
    if (revoke) changes.push(statement(env.DB, 'DELETE FROM sessions WHERE user_id=?1', user.id));
    if (cancel) changes.push(statement(env.DB, `UPDATE jobs SET cancel_requested=1,
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      finished_at=CASE WHEN status='queued' THEN ?1 ELSE finished_at END WHERE user_id=?2 AND status IN ('queued','running')`, now, user.id));
    changes.push(auditStatement(env.DB, session, now, action, user.id, {...detail,username:user.username}));
    await env.DB.batch(changes);
    return json({ok: true});
  }
  const voiceMatch = /^\/voices\/([^/]+)$/.exec(path);
  if (voiceMatch && request.method === 'PATCH') {
    const id = decodeURIComponent(voiceMatch[1]), body = await readJson(request);
    if (typeof body.hidden !== 'boolean') fail(400, 'invalid_hidden', '请选择显示或隐藏声线');
    const voice = await row(env.DB, 'SELECT id,name FROM voices WHERE id=?1', id);
    if (!voice) fail(404, 'voice_not_found', '找不到声线');
    await env.DB.batch([statement(env.DB, 'UPDATE voices SET hidden=?1 WHERE id=?2', body.hidden ? 1 : 0,id),
      auditStatement(env.DB, session, now, body.hidden ? 'voice.hide' : 'voice.show', id, {name: voice.name})]);
    return json({ok: true});
  }
  if (path === '/settings' && request.method === 'PUT') {
    const body = await readJson(request);
    const pending = body.max_pending_jobs ?? (await siteSettings(env.DB)).max_pending_jobs;
    if (!Number.isInteger(pending) || pending < 1 || pending > 10) fail(400, 'invalid_settings', '每人待处理上限应为 1～10');
    if (!Number.isInteger(body.max_text_length) || body.max_text_length<1 || body.max_text_length>300 || typeof body.accepting_jobs!=='boolean')
      fail(400, 'invalid_settings', '字数上限应为 1～300 的整数，并设置是否接收任务');
    await env.DB.batch([statement(env.DB, 'UPDATE site_settings SET max_text_length=?1,accepting_jobs=?2,max_pending_jobs=?3 WHERE id=1', body.max_text_length, body.accepting_jobs ? 1 : 0,pending),
      auditStatement(env.DB, session, now, 'settings.update', 'site', {max_text_length:body.max_text_length,accepting_jobs:body.accepting_jobs,max_pending_jobs:pending})]);
    return json({ok: true, settings: await siteSettings(env.DB)});
  }
  const jobMatch = /^\/jobs\/([1-9]\d*)\/cancel$/.exec(path);
  if (jobMatch && request.method === 'POST') {
    const id = Number(jobMatch[1]);
    const job = await row(env.DB, 'SELECT id,status FROM jobs WHERE id=?1 AND deleted_at IS NULL', id);
    if (!job) fail(404, 'job_not_found', '找不到任务');
    if (!['queued','running'].includes(job.status)) fail(409, 'job_finished', '任务已经结束');
    await env.DB.batch([statement(env.DB, `UPDATE jobs SET cancel_requested=1,
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      finished_at=CASE WHEN status='queued' THEN ?1 ELSE finished_at END WHERE id=?2 AND status IN ('queued','running')`, now,id),
      auditStatement(env.DB, session, now, 'job.cancel', String(id))]);
    return json({ok: true});
  }
  fail(404, 'not_found', '找不到这个管理接口');
}

async function userApi(request, env, url, now) {
  let session = await findSession(request, env.DB, now);
  if (url.pathname === '/api/me' && request.method === 'GET') {
    let cookie;
    if (!session) { const created = await createSession(env.DB, null, now); session = created.session; cookie = created.cookie; }
    return json({authenticated: Boolean(session.user_id), user: publicUser(session), csrf_token: session.csrf_token}, 200, cookie ? {'Set-Cookie': cookie} : {});
  }
  if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env, session, now);
  if (url.pathname === '/api/register' && request.method === 'POST') return register(request, env, session, now);
  if (url.pathname === '/api/logout' && request.method === 'POST') {
    requireCsrf(request, session);
    await statement(env.DB, 'DELETE FROM sessions WHERE token_hash=?1', session.token_hash).run();
    return json({ok: true}, 200, {'Set-Cookie': sessionCookie('', 0)});
  }
  const userId = requireUser(session);
  if (!['GET', 'HEAD'].includes(request.method)) requireCsrf(request, session);
  if (url.pathname.startsWith('/api/admin/')) return adminApi(request, env, url, now, session);
  if (url.pathname === '/api/voices' && request.method === 'GET') {
    const voices = await rows(env.DB, 'SELECT id,name,available,description,reference_seconds FROM voices WHERE hidden=0 ORDER BY available DESC,name');
    return json({voices: voices.map(v => ({...v, available: Boolean(v.available), reference_url: v.available ? `/api/voices/${encodeURIComponent(v.id)}/reference` : null})), worker: await workerStatus(env, now), settings: await siteSettings(env.DB)});
  }
  if (url.pathname === '/api/jobs' && request.method === 'GET') {
    const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1) fail(400, 'invalid_cursor', '翻页位置不正确');
    const status = url.searchParams.get('status') || '', voice = url.searchParams.get('voice_id') || '';
    const voiceQuery = (url.searchParams.get('voice_query') || '').trim();
    if (Array.from(voiceQuery).length > 80) fail(400, 'invalid_voice_query', '角色搜索最多输入 80 字');
    const voicePattern = `%${voiceQuery.replace(/[\\%_]/g, '\\$&')}%`;
    if (status && !['queued','running','completed','failed','cancelled'].includes(status)) fail(400,'invalid_status','状态不正确');
    const deleted = url.searchParams.get('deleted') === '1';
    const active = deleted ? [] : await rows(env.DB, SQL_OWN_JOBS, userId);
    const history = await rows(env.DB, `SELECT j.*,v.name voice_name FROM jobs j JOIN voices v ON v.id=j.voice_id
      WHERE j.user_id=?1 AND j.id<?2 AND (?3='' OR j.voice_id=?3) AND (?4='' OR j.status=?4)
      AND v.name LIKE ?7 ESCAPE '\\'
      AND ((?5=0 AND j.deleted_at IS NULL AND j.status NOT IN ('queued','running')) OR
        (?5=1 AND j.deleted_at IS NOT NULL AND j.deleted_at>?6 AND j.reclaimed_at IS NULL))
      ORDER BY j.id DESC LIMIT 21`, userId,before,voice,status,deleted?1:0,now-604800,voicePattern);
    const page = history.slice(0,20), jobs = [...active,...page];
    const queue = await row(env.DB, "SELECT coalesce(sum(status='running'),0) AS active_count,coalesce(sum(status='queued'),0) AS queued_count FROM jobs WHERE status IN ('queued','running')");
    return json({jobs: jobs.map(publicJob), active_jobs: active.map(publicJob), history_jobs: page.map(publicJob), next_before: history.length>20 ? page.at(-1).id : null, storage: await storageStatus(env), queue, worker: await workerStatus(env, now), settings: await siteSettings(env.DB)});
  }
  if (url.pathname === '/api/jobs' && request.method === 'POST') {
    const body = await readJson(request);
    const settings = await siteSettings(env.DB);
    if (!settings.accepting_jobs) fail(503, 'submissions_paused', '管理员已暂停接收新任务，已有任务继续处理');
    const text = validateText(body.text, settings.max_text_length), key = validateRequestKey(body.request_key);
    if (typeof body.voice_id !== 'string' || body.voice_id.length > 120) fail(400, 'invalid_voice', '请选择声线');
    const voice = await row(env.DB, 'SELECT id FROM voices WHERE id=?1 AND available=1 AND hidden=0', body.voice_id);
    if (!voice) fail(400, 'voice_unavailable', '这个声线还未开放，请选择可用声线');
    const existing = await row(env.DB,'SELECT id FROM jobs WHERE user_id=?1 AND request_key=?2',userId,key);
    if (!existing) {
      const pending = await row(env.DB,"SELECT count(*) n FROM jobs WHERE user_id=?1 AND status IN ('queued','running')",userId);
      if (pending.n >= settings.max_pending_jobs) fail(429,'pending_limit','待处理任务已达上限，请等待完成或取消后再提交');
      if (!(await storageStatus(env)).accepting_jobs) fail(507,'storage_low','音频存储空间不足，已暂停新请求，已有任务继续处理');
    }
    await statement(env.DB, `INSERT INTO jobs(user_id,voice_id,text,request_key,created_at) SELECT ?1,?2,?3,?4,?5
      WHERE EXISTS(SELECT 1 FROM users WHERE id=?1 AND active=1 AND deleted_at IS NULL)
      AND EXISTS(SELECT 1 FROM voices WHERE id=?2 AND available=1 AND hidden=0)
      AND EXISTS(SELECT 1 FROM site_settings WHERE id=1 AND accepting_jobs=1 AND length(?3)<=max_text_length
        AND (SELECT count(*) FROM jobs WHERE user_id=?1 AND status IN ('queued','running'))<max_pending_jobs)
      AND (?6=0 OR ((SELECT coalesce(sum(size),0) FROM audio_uploads) < ?7*0.95
        AND (SELECT coalesce(sum(size),0) FROM audio_uploads)+(1+(SELECT count(*) FROM jobs WHERE status IN ('queued','running')))*?8<=?7))
      ON CONFLICT(user_id,request_key) DO NOTHING`, userId, body.voice_id, text, key, now,env.AUDIO_STORAGE==='d1'?1:0,audioQuota(env),D1_MAX_AUDIO_BYTES).run();
    const job = await row(env.DB, 'SELECT j.*,v.name AS voice_name FROM jobs j JOIN voices v ON v.id=j.voice_id WHERE user_id=?1 AND request_key=?2', userId, key);
    if (!job) fail(409, 'configuration_changed', '账号或声馆设置已变化，请刷新后重试');
    if (job.deleted_at) fail(410, 'request_deleted', '这个请求已删除，请用新的请求标识提交');
    if (job.voice_id !== body.voice_id || job.text !== text) fail(409, 'request_key_conflict', '请求标识已用于其他内容');
    // Reuse the listing calculation so creation and polling show identical positions.
    const listed = (await rows(env.DB, SQL_OWN_JOBS, userId)).find(j => j.id === job.id) || job;
    return json({job: publicJob(listed)}, 201);
  }
  const referenceMatch = /^\/api\/voices\/([^/]+)\/reference$/.exec(url.pathname);
  if (referenceMatch && ['GET', 'HEAD'].includes(request.method)) {
    const voice = await row(env.DB, 'SELECT reference_key FROM voices WHERE id=?1 AND available=1 AND hidden=0', decodeURIComponent(referenceMatch[1]));
    if (!voice?.reference_key) fail(404, 'voice_not_found', '找不到这个声线');
    return streamAudio(request, env, voice.reference_key, 'reference.wav');
  }
  const match = /^\/api\/jobs\/([1-9]\d*)(?:\/(cancel|audio|restore))?$/.exec(url.pathname);
  if (match) {
    const id = Number(match[1]);
    if (match[2] === 'restore' && request.method === 'POST') {
      const restored = await row(env.DB, `UPDATE jobs SET deleted_at=NULL WHERE id=?1 AND user_id=?2
        AND deleted_at>?3 AND reclaimed_at IS NULL AND status NOT IN ('queued','running') RETURNING *`,id,userId,now-604800);
      if (!restored) fail(409,'restore_unavailable','请求已超过七天恢复期、已回收或仍在取消中');
      return json({job:publicJob(restored)});
    }
    const job = await ownJob(env, userId, id);
    if (match[2] === 'audio' && ['GET', 'HEAD'].includes(request.method)) {
      if (job.status !== 'completed' || !job.audio_key) fail(409, 'audio_not_ready', '音频尚未生成完成');
      return streamAudio(request, env, job.audio_key, `shendu-voice-${id}.wav`);
    }
    if (match[2] === 'cancel' && request.method === 'POST') {
      const updated = await row(env.DB, `UPDATE jobs SET
        cancel_requested=CASE WHEN status IN ('queued','running') THEN 1 ELSE cancel_requested END,
        status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
        finished_at=CASE WHEN status='queued' THEN ?1 ELSE finished_at END
        WHERE id=?2 AND user_id=?3 AND deleted_at IS NULL RETURNING *`, now, id, userId);
      return json({job: publicJob({...updated, voice_name: job.voice_name})});
    }
    if (!match[2] && request.method === 'DELETE') {
      await statement(env.DB, `UPDATE jobs SET deleted_at=?1,
        cancel_requested=CASE WHEN status IN ('queued','running') THEN 1 ELSE cancel_requested END,
        status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
        finished_at=CASE WHEN status='queued' THEN ?1 ELSE finished_at END
        WHERE id=?2 AND user_id=?3 AND deleted_at IS NULL`, now, id, userId).run();
      return json({ok: true});
    }
    if (!match[2] && request.method === 'GET') return json({job: publicJob(job)});
    fail(405, 'method_not_allowed', '请求方法不支持');
  }
  fail(404, 'not_found', '找不到这个接口');
}

export default {
  async scheduled(event,env,ctx) {
    ctx.waitUntil((async()=>{
      const now=nowSeconds(), candidates=await cleanupCandidates(env,now);
      if(candidates.length) await cleanupAudio(env,now,candidates.slice(0,20).map(c=>c.version_id),null);
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (!env.AUDIO && env.AUDIO_STORAGE === 'd1') env = {...env, AUDIO: new D1AudioStore(env.DB, {quotaBytes:audioQuota(env)})};
      if (url.pathname.startsWith('/api/worker/')) return await workerApi(request, env, url, nowSeconds());
      if (url.pathname.startsWith('/api/')) return await userApi(request, env, url, nowSeconds());
      if (!['GET', 'HEAD'].includes(request.method)) fail(405, 'method_not_allowed', '请求方法不支持');
      const asset = await env.ASSETS.fetch(request);
      const headers = securityHeaders(new Headers(asset.headers));
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      return new Response(asset.body, {status: asset.status, statusText: asset.statusText, headers});
    } catch (error) {
      if (error instanceof ApiError || error instanceof StorageError) return json({error: {code: error.code, message: error.message}}, error.status);
      console.error('Voice station API failure', error?.name || 'Error');
      return json({error: {code: 'internal_error', message: '服务暂时出错，请稍后重试'}}, 500);
    }
  },
};
