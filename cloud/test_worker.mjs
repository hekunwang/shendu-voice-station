import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { pbkdf2Sync } from 'node:crypto';
import worker, {ApiError, validateText, validateRequestKey, parseRange, secureEqual, passwordHash,
  audioKey, SQL_CLAIM, SQL_RECOVER} from './worker.js';
import {D1AudioStore, D1_CHUNK_BYTES, D1_MAX_AUDIO_BYTES, StorageError} from './d1_audio.js';

// Existing Node's built-in SQLite: no package installation, no disk database.
class D1Mock {
  constructor() { this.queryCount=0; this.sql = new DatabaseSync(':memory:'); this.sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    this.queryCount++; if (this.onPrepare) this.onPrepare(sql);
    const database = this.sql;
    return {bind(...args) {
      const bindings = Object.fromEntries(args.map((value, i) => [String(i + 1), value instanceof ArrayBuffer ? new Uint8Array(value) : value]));
      const query = database.prepare(sql);
      const all = () => query.all(bindings).map(r => {
        const result = {...r};
        // Cloudflare D1 reads BLOBs as Array<number>, unlike node:sqlite.
        for(const key of Object.keys(result)) if(result[key] instanceof Uint8Array) result[key]=Array.from(result[key]);
        return result;
      });
      return {async first() { return all()[0] || null; }, async all() { return {success: true, results: all()}; },
        async run() { const meta = query.run(bindings); return {success: true, meta, results: []}; }};
    }};
  }
  async batch(statements) {
    this.sql.exec('BEGIN');
    try { const result = []; for (const statement of statements) result.push(await statement.run()); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
}
class R2Mock {
  objects = new Map();
  async put(key, body, options = {}) {
    const data = new Uint8Array(await new Response(body).arrayBuffer());
    const object = {key, size: data.length, httpEtag: '"test-etag"', httpMetadata: options.httpMetadata || {}, data};
    this.objects.set(key, object); return object;
  }
  async head(key) { if (this.onHead) { const hook = this.onHead; this.onHead = null; await hook(key); } return this.objects.get(key) || null; }
  async get(key, options) {
    const object = this.objects.get(key); if (!object) return null;
    const range = options?.range;
    const body = range ? object.data.slice(range.offset, range.offset + range.length) : object.data;
    return {...object, body};
  }
}
let checks = 0;
function ok(value, message) { assert.ok(value, message); checks++; }
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
function rejected(fn, status) { assert.throws(fn, e => e instanceof ApiError && e.status === status); checks++; }
equal(validateText('  西王母，您好。  '), '西王母，您好。');
equal([...validateText('😀'.repeat(300))].length, 300);
rejected(() => validateText('😀'.repeat(301)), 400);
rejected(() => validateText(' \n '), 400);
rejected(() => validateText('bad\0text'), 400);
rejected(() => validateRequestKey('../not-a-key'), 400);
equal(secureEqual('abcdef', 'abcdef'), true);
equal(secureEqual('abcdef', 'abcdeg'), false);
equal(secureEqual('abcdef', 'abc'), false);
const salt = '1234567890abcdef1234567890abcdef';
equal(await passwordHash('样本 password', salt), pbkdf2Sync('样本 password', Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex'));
equal(parseRange('bytes=0-10', 64), {offset: 0, length: 11});
equal(parseRange('bytes=10-', 64), {offset: 10, length: 54});
equal(parseRange('bytes=-10', 64), {offset: 54, length: 10});
equal(parseRange('bytes=-200', 64), {offset: 0, length: 64});
equal(parseRange('bytes=10-1000', 64), {offset: 10, length: 54});
for (const value of ['bytes=64-', 'bytes=12-1', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'wat']) rejected(() => parseRange(value, 64), 416);
equal(audioKey(123, 'a'.repeat(64)), `jobs/123/${'a'.repeat(64)}.wav`);
rejected(() => audioKey('../1', 'a'.repeat(64)), 400);

const env = {DB: new D1Mock(), AUDIO: new R2Mock(), WORKER_TOKEN: 'only-a-test-secret',
  LEASE_SECONDS: '300', ASSETS: {fetch: async () => new Response('<!doctype html>test', {headers: {'Content-Type': 'text/html'}})}};
const now = () => Math.floor(Date.now() / 1000);
for (const [id, username] of [['u1', 'alice'], ['u2', 'bob']]) {
  env.DB.sql.prepare('INSERT INTO users(id,username,display_name,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)')
    .run(id, username, username, salt, await passwordHash('test-password', salt), now());
}
env.DB.sql.exec(`INSERT INTO voices(id,name,available,reference_key,reference_text,reference_seconds) VALUES
  ('queen','西王母',1,'references/queen.wav','西王母样本台词',6.32),
  ('heroine','女主角',1,'references/heroine.wav','女主角样本台词',9.34),
  ('staged','暂存角色',0,'references/staged.wav','暂存角色的样本台词',6),
  ('pending','待验收',0,NULL,NULL,NULL);`);
await env.AUDIO.put('references/queen.wav', new Uint8Array(64).fill(1), {httpMetadata: {contentType: 'audio/wav'}});
const origin = 'https://voice.example';
async function call(path, {method = 'GET', body, actor, bearer, headers = {}} = {}) {
  const h = new Headers(headers);
  if (actor?.cookie) h.set('Cookie', actor.cookie);
  if (actor?.csrf && !h.has('X-CSRF-Token')) h.set('X-CSRF-Token', actor.csrf);
  if (bearer) h.set('Authorization', `Bearer ${bearer}`);
  if (!['GET', 'HEAD'].includes(method) && !h.has('Origin')) h.set('Origin', origin);
  let payload = body;
  if (body && !(body instanceof Uint8Array)) { payload = JSON.stringify(body); h.set('Content-Type', 'application/json'); }
  const response = await worker.fetch(new Request(`${origin}${path}`, {method, headers: h, body: payload}), env);
  const json = response.headers.get('Content-Type')?.startsWith('application/json') ? await response.clone().json() : null;
  return {response, json};
}
async function actor(username) {
  const me = await call('/api/me');
  equal(me.json.authenticated, false);
  const cookie = me.response.headers.get('Set-Cookie').split(';')[0];
  ok(me.response.headers.get('Set-Cookie').includes('HttpOnly; Secure; SameSite=Lax'));
  const result = await call('/api/login', {method: 'POST', actor: {cookie, csrf: me.json.csrf_token}, body: {username, password: 'test-password'}});
  equal(result.response.status, 200);
  equal(result.json.authenticated, true);
  ok(result.response.headers.get('Set-Cookie').split(';')[0] !== cookie, 'rotate session on login');
  ok(result.json.csrf_token !== me.json.csrf_token, 'rotate CSRF on login');
  return {cookie: result.response.headers.get('Set-Cookie').split(';')[0], csrf: result.json.csrf_token};
}
const alice = await actor('alice'), bob = await actor('bob');
equal((await call('/api/jobs')).response.status, 401);
equal((await call('/api/jobs', {method: 'POST', actor: {...alice, csrf: ''}, body: {voice_id: 'queen', text: 'a', request_key: 'test-key-1'}})).response.status, 403);
equal((await call('/api/jobs', {method: 'POST', actor: alice, headers: {Origin: 'https://attacker.example'}, body: {voice_id: 'queen', text: 'a', request_key: 'test-key-1'}})).response.status, 403);
const voices = await call('/api/voices', {actor: alice});
equal(voices.json.voices.length, 4);
ok(!('reference_key' in voices.json.voices[0]) && !('reference_text' in voices.json.voices[0]));
equal(voices.json.worker.ready, false);
const job = async (actor, key, text = '这是一句台词。', voice_id = 'queen') => call('/api/jobs', {method: 'POST', actor, body: {voice_id, text, request_key: key}});
equal((await job(alice, 'unavailable-key', 'test', 'pending')).response.status, 400);
const one = (await job(alice, 'request-0001')).json.job;
const two = (await job(bob, 'request-0002', '另一个人的私密文本。')).json.job;
const three = (await job(alice, 'request-0003')).json.job;
equal([one.queue_position, two.queue_position, three.queue_position], [1, 2, 3]);
equal((await job(alice, 'request-0001')).json.job.id, one.id);
equal((await job(alice, 'request-0001', '换文本。')).response.status, 409);
equal(env.DB.sql.prepare('SELECT count(*) n FROM jobs').get().n, 3);
let listing = await call('/api/jobs', {actor: alice});
equal(listing.json.jobs.map(j => j.id), [three.id, one.id]);
ok(!JSON.stringify(listing.json).includes('另一个人的私密文本'));
ok(!('user_id' in listing.json.jobs[0]) && !('lease_token' in listing.json.jobs[0]));
equal((await call(`/api/jobs/${two.id}`, {actor: alice})).response.status, 404);
equal((await call(`/api/jobs/${two.id}/cancel`, {method: 'POST', actor: alice})).response.status, 404);
equal((await call(`/api/jobs/${two.id}`, {method: 'DELETE', actor: alice})).response.status, 404);
const workerCall = (path, body, options = {}) => call(`/api/worker${path}`, {method: 'POST', body, bearer: env.WORKER_TOKEN, ...options});
equal((await workerCall('/heartbeat', {worker_id: 'mac-a', ready: true, message: '生成电脑在线'})).response.status, 200);
equal((await call('/api/voices', {actor: alice})).json.worker.ready, true);
equal((await call('/api/worker/claim?worker_id=mac-a')).response.status, 401);
const claim = (await workerCall('/claim', {worker_id: 'mac-a'})).json.job;
equal(claim.id, one.id);
equal(claim.reference_text, '西王母样本台词');
equal((await workerCall('/claim', {worker_id: 'mac-b'})).json.unavailable, 'busy');
listing = await call('/api/jobs', {actor: alice});
equal(listing.json.jobs.find(j => j.id === three.id).queue_position, 3);
equal(listing.json.jobs.find(j => j.id === one.id).queue_position, 1);
equal((await workerCall(`/jobs/${one.id}/heartbeat`, {lease_token: 'f'.repeat(64)})).response.status, 409);
equal((await workerCall(`/jobs/${one.id}/heartbeat`, {lease_token: claim.lease_token})).json.cancel_requested, false);
equal((await call(`/api/jobs/${one.id}/audio`, {actor: alice})).response.status, 409);
const audio = new Uint8Array(96).map((_, i) => i);
const upload = await workerCall(`/jobs/${one.id}/audio?lease_token=${claim.lease_token}`, audio, {method: 'PUT', headers: {'Content-Type': 'audio/wav', 'Content-Length': String(audio.length)}});
equal(upload.response.status, 200);
equal(upload.json.audio_key, audioKey(one.id, claim.lease_token));
const complete = await workerCall(`/jobs/${one.id}/finish`, {lease_token: claim.lease_token, status: 'completed', audio_key: upload.json.audio_key, duration_seconds: 3.1});
equal(complete.json.job.status, 'completed');
equal((await call(`/api/jobs/${one.id}/audio`, {actor: bob})).response.status, 404);
let playback = await call(`/api/jobs/${one.id}/audio`, {actor: alice, headers: {Range: 'bytes=10-19'}});
equal(playback.response.status, 206);
equal(playback.response.headers.get('Content-Range'), 'bytes 10-19/96');
equal([...new Uint8Array(await playback.response.arrayBuffer())], [...audio.slice(10, 20)]);
playback = await call(`/api/jobs/${one.id}/audio`, {actor: alice, method: 'HEAD', headers: {Range: 'bytes=-4'}});
equal(playback.response.headers.get('Content-Length'), '4');
equal(await playback.response.text(), '');
equal((await call(`/api/jobs/${one.id}/audio`, {actor: alice, headers: {Range: 'bytes=96-'}})).response.status, 416);
equal((await call(`/api/jobs/${one.id}/audio?download=1`, {actor: alice})).response.headers.get('Content-Disposition'), `attachment; filename="shendu-voice-${one.id}.wav"`);
equal((await call('/api/voices/queen/reference', {actor: alice})).response.status, 200);
equal((await call('/api/worker/voices/queen/reference', {bearer: env.WORKER_TOKEN})).response.status, 200);
const validReference = new Uint8Array(64); validReference.set(new TextEncoder().encode('RIFF')); validReference.set(new TextEncoder().encode('WAVE'),8);
equal((await workerCall('/voices/queen/reference', validReference, {method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':'64'}})).response.status, 200);
equal((await workerCall('/voices/pending/reference', validReference, {method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':'64'}})).response.status, 404);
equal((await workerCall('/voices/queen/reference', audio, {method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':'96'}})).response.status, 400);
// Upload a configured voice before exposing it; only explicit DB activation opens playback and jobs.
const stagedUpload = await workerCall('/voices/staged/reference', validReference, {method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':'64'}});
equal(stagedUpload.response.status, 200);
equal(stagedUpload.json.voice_id, 'staged');
equal(stagedUpload.json.size, 64);
equal({...env.DB.sql.prepare("SELECT available,reference_text FROM voices WHERE id='staged'").get()}, {available:0,reference_text:'暂存角色的样本台词'});
ok(env.AUDIO.objects.has('references/staged.wav'));
const stagedVoice = (await call('/api/voices', {actor:alice})).json.voices.find(v => v.id === 'staged');
equal(stagedVoice.available, false);
equal(stagedVoice.reference_url, null);
for (const method of ['GET','HEAD']) {
  equal((await call('/api/voices/staged/reference', {actor:alice,method})).response.status, 404);
  equal((await call('/api/worker/voices/staged/reference', {bearer:env.WORKER_TOKEN,method})).response.status, 404);
}
equal((await job(alice, 'staged-unavailable-key', '尚未开放的测试。', 'staged')).response.status, 400);
equal((await call('/api/worker/voices/staged/reference', {actor:alice,method:'PUT',body:validReference,headers:{'Content-Type':'audio/wav','Content-Length':'64'}})).response.status, 401);
equal((await workerCall('/voices/staged/reference', validReference, {method:'PUT',headers:{'Content-Type':'text/plain','Content-Length':'64'}})).response.status, 415);
equal((await workerCall('/voices/staged/reference', validReference, {method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':'65'}})).response.status, 413);
env.DB.sql.exec("UPDATE voices SET reference_key='references/pending.wav' WHERE id='pending'");
equal((await workerCall('/voices/pending/reference', validReference, {method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':'64'}})).response.status, 404);
env.DB.sql.exec("UPDATE voices SET reference_text='   ' WHERE id='pending'");
equal((await workerCall('/voices/pending/reference', validReference, {method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':'64'}})).response.status, 404);
env.DB.sql.exec("UPDATE voices SET reference_key='  ',reference_text='有效台词' WHERE id='pending'");
equal((await workerCall('/voices/pending/reference', validReference, {method:'PUT',headers:{'Content-Type':'audio/wav','Content-Length':'64'}})).response.status, 404);
env.DB.sql.exec("UPDATE voices SET reference_key=NULL,reference_text=NULL WHERE id='pending'; UPDATE voices SET available=1 WHERE id='staged'");
equal((await call('/api/voices/staged/reference', {actor:alice})).response.status, 200);
equal((await call('/api/worker/voices/staged/reference', {bearer:env.WORKER_TOKEN})).response.status, 200);
equal((await call('/api/voices', {actor:alice})).json.voices.find(v => v.id === 'staged').reference_url, '/api/voices/staged/reference');
const secondClaim = (await workerCall('/claim', {worker_id: 'mac-a'})).json.job;
equal(secondClaim.id, two.id);
equal((await call(`/api/jobs/${two.id}/cancel`, {actor: bob, method: 'POST'})).json.job.status, 'running');
equal((await workerCall(`/jobs/${two.id}/heartbeat`, {lease_token: secondClaim.lease_token})).json.cancel_requested, true);
equal((await workerCall(`/jobs/${two.id}/finish`, {lease_token: secondClaim.lease_token, status: 'completed'})).json.job.status, 'cancelled');
const thirdClaim = (await workerCall('/claim', {worker_id: 'mac-a'})).json.job;
equal(thirdClaim.id, three.id);
await call(`/api/jobs/${three.id}`, {actor: alice, method: 'DELETE'});
equal((await call('/api/jobs', {actor: alice})).json.jobs.map(j => j.id), [one.id]);
equal((await workerCall('/claim', {worker_id: 'mac-a'})).json.unavailable, 'busy', 'hidden running job still blocks overlap');
equal((await workerCall(`/jobs/${three.id}/finish`, {lease_token: thirdClaim.lease_token, status: 'completed'})).json.job.status, 'cancelled');
equal((await job(alice, 'request-0003')).response.status, 410);

const four = (await job(alice, 'request-0004')).json.job;
const expired = (await workerCall('/claim', {worker_id: 'mac-a'})).json.job;
env.DB.sql.prepare('UPDATE jobs SET lease_expires_at=? WHERE id=?').run(now() - 1, four.id);
equal((await workerCall('/claim', {worker_id: 'mac-b'})).json.unavailable, 'stale_lease');
equal((await workerCall('/recover', {worker_id: 'mac-b'})).json.recovered, []);
equal((await workerCall('/recover', {worker_id: 'mac-a'})).json.recovered, [{id: four.id, status: 'queued'}]);
const reclaimed = (await workerCall('/claim', {worker_id: 'mac-a'})).json.job;
equal(reclaimed.id, four.id);
ok(reclaimed.lease_token !== expired.lease_token);
equal(reclaimed.attempt, 2);
equal((await workerCall(`/jobs/${four.id}/finish`, {lease_token: expired.lease_token, status: 'failed'})).response.status, 409);
// Enforce single running even if a caller bypasses the claim function.
assert.throws(() => env.DB.sql.prepare("INSERT INTO jobs(user_id,voice_id,text,request_key,status,created_at) VALUES('u1','queen','x','unsafe-direct','running',?)").run(now()), /UNIQUE constraint/); checks++;
await workerCall(`/jobs/${four.id}/finish`, {lease_token: reclaimed.lease_token, status: 'failed', error: '测试失败'});

// Cancellation arriving during completion's R2 lookup must win atomically.
const five = (await job(alice, 'request-0005')).json.job;
const fifthClaim = (await workerCall('/claim', {worker_id: 'mac-a'})).json.job;
const fifthUpload = await workerCall(`/jobs/${five.id}/audio?lease_token=${fifthClaim.lease_token}`, audio, {method: 'PUT', headers: {'Content-Type': 'audio/wav', 'Content-Length': '96'}});
env.AUDIO.onHead = async () => { env.DB.sql.prepare('UPDATE jobs SET cancel_requested=1 WHERE id=?').run(five.id); };
equal((await workerCall(`/jobs/${five.id}/finish`, {lease_token: fifthClaim.lease_token, status: 'completed', audio_key: fifthUpload.json.audio_key, duration_seconds: 3})).json.job.status, 'cancelled');
equal(env.DB.sql.prepare('SELECT audio_key FROM jobs WHERE id=?').get(five.id).audio_key, null);
equal((await workerCall(`/jobs/${five.id}/finish`, {lease_token: fifthClaim.lease_token, status: 'completed'})).response.status, 409);

// A stopped local process releases its claim back to its original FIFO position.
const six = (await job(alice, 'request-0006')).json.job;
const seven = (await job(bob, 'request-0007')).json.job;
const sixthClaim = (await workerCall('/claim', {worker_id: 'mac-a'})).json.job;
equal((await workerCall(`/jobs/${six.id}/release`, {lease_token: 'f'.repeat(64)})).response.status, 409);
equal((await workerCall(`/jobs/${six.id}/release`, {lease_token: sixthClaim.lease_token})).json.job.status, 'queued');
equal((await workerCall(`/jobs/${six.id}/heartbeat`, {lease_token: sixthClaim.lease_token})).response.status, 409);
equal((await workerCall('/claim', {worker_id: 'mac-a'})).json.job.id, six.id);
const sixthNewToken = env.DB.sql.prepare('SELECT lease_token FROM jobs WHERE id=?').get(six.id).lease_token;
await call(`/api/jobs/${six.id}/cancel`, {actor: alice, method: 'POST'});
equal((await workerCall(`/jobs/${six.id}/release`, {lease_token: sixthNewToken})).json.job.status, 'cancelled');
const seventhClaim = (await workerCall('/claim', {worker_id: 'mac-a'})).json.job;
equal(seventhClaim.id, seven.id);
await call(`/api/jobs/${seven.id}`, {actor: bob, method: 'DELETE'});
equal((await workerCall(`/jobs/${seven.id}/release`, {lease_token: seventhClaim.lease_token})).json.job.status, 'cancelled');

// Fresh anonymous cookie cannot authenticate; logout invalidates server-side session.
const loggedOut = await call('/api/logout', {actor: alice, method: 'POST', body: {}});
equal(loggedOut.response.status, 200);
equal((await call('/api/jobs', {actor: alice})).response.status, 401);
let limited;
const anonymous = await call('/api/me');
const loginActor = {cookie: anonymous.response.headers.get('Set-Cookie').split(';')[0], csrf: anonymous.json.csrf_token};
for (let i = 0; i < 21; i++) limited = await call('/api/login', {actor: loginActor, method: 'POST', headers: {'CF-Connecting-IP': '192.0.2.10'}, body: {username: 'missing', password: 'wrong'}});
equal(limited.response.status, 429);
for (const path of ['/api/me', '/api/jobs', '/api/unknown']) equal((await call(path)).response.headers.get('Cache-Control'), 'private, no-store');
const asset = await call('/');
ok(asset.response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));

// D1 fallback uses immutable BLOB chunks and publishes its manifest last.
const audioDb = new D1Mock(), store = new D1AudioStore(audioDb);
const binary = new Uint8Array(D1_CHUNK_BYTES * 2 + 111).map((_,i)=>i % 251);
const metadata = await store.put('testing/voice.wav', binary, {httpMetadata:{contentType:'audio/wav'}});
equal(metadata.size, binary.length);
equal(audioDb.sql.prepare('SELECT count(*) n FROM audio_chunks').get().n, 3);
equal(audioDb.sql.prepare('SELECT max(length(data)) n FROM audio_chunks').get().n, D1_CHUNK_BYTES);
equal([...new Uint8Array(await new Response((await store.get('testing/voice.wav')).body).arrayBuffer())], [...binary]);
const offset = D1_CHUNK_BYTES-11, length = 99;
equal([...new Uint8Array(await new Response((await store.get('testing/voice.wav',{range:{offset,length}})).body).arrayBuffer())], [...binary.slice(offset,offset+length)]);
const reservedBytes = audioDb.sql.prepare('SELECT sum(size) n FROM audio_uploads').get().n;
await store.put('testing/voice.wav', binary);
equal(audioDb.sql.prepare('SELECT sum(size) n FROM audio_uploads').get().n, reservedBytes, 'identical retry is quota-idempotent');
equal(await store.get('missing'), null);

const incomplete = new Uint8Array(D1_CHUNK_BYTES * 13 + 5).fill(9);
let inserts=0;
audioDb.onPrepare = sql => { if(sql.startsWith('INSERT INTO audio_chunks') && ++inserts===2) throw new Error('simulated network failure'); };
await assert.rejects(store.put('testing/incomplete.wav',incomplete),/simulated network failure/); checks++;
audioDb.onPrepare = null;
equal(await store.head('testing/incomplete.wav'), null, 'interrupted chunks stay invisible');
const reservationAfterFailure = audioDb.sql.prepare('SELECT sum(size) n FROM audio_uploads').get().n;
await store.put('testing/incomplete.wav',incomplete);
equal(audioDb.sql.prepare('SELECT sum(size) n FROM audio_uploads').get().n, reservationAfterFailure, 'resume uses the same reservation');
equal((await store.head('testing/incomplete.wav')).size,incomplete.length);

const quotaDb=new D1Mock(), smallStore=new D1AudioStore(quotaDb,{quotaBytes:256});
const raced=await Promise.allSettled([smallStore.put('a',new Uint8Array(200)),smallStore.put('b',new Uint8Array(200))]);
equal(raced.filter(r=>r.status==='fulfilled').length,1,'concurrent reservations cannot overrun quota');
ok(raced.find(r=>r.status==='rejected').reason instanceof StorageError);
equal(raced.find(r=>r.status==='rejected').reason.status,507);
equal(quotaDb.sql.prepare('SELECT sum(size) n FROM audio_uploads').get().n,200);
await assert.rejects(smallStore.put('big',new Uint8Array(10),{customMetadata:{text:'a'.repeat(2000)}}),e=>e.code==='audio_metadata_invalid'); checks++;
await assert.rejects(new D1AudioStore(quotaDb,{maxObjectBytes:10}).put('too-large',new Uint8Array(11)),e=>e.status===413); checks++;

// Maximum 25MiB object: upload and complete streaming read stay below 50 D1 queries.
const maximum = new Uint8Array(D1_MAX_AUDIO_BYTES).fill(12);
const queryStart = audioDb.queryCount; await store.put('testing/max.wav',maximum);
ok(audioDb.queryCount-queryStart<=25, 'upload fits D1 Free request query limit');
const getStart=audioDb.queryCount, maxRead=await store.get('testing/max.wav');
equal((await new Response(maxRead.body).arrayBuffer()).byteLength,maximum.length);
ok(audioDb.queryCount-getStart<=30, 'full streaming read fits D1 Free request query limit');

// Full user API can transparently stream D1 references, without an R2 binding.
const d1Env={...env,AUDIO:undefined,AUDIO_STORAGE:'d1'};
const d1Reference = await worker.fetch(new Request(`${origin}/api/worker/voices/queen/reference`,{method:'PUT',
  headers:{Authorization:`Bearer ${env.WORKER_TOKEN}`,'Content-Type':'audio/wav','Content-Length':'64'},body:validReference}),d1Env);
equal(d1Reference.status,200);
const d1Playback = await worker.fetch(new Request(`${origin}/api/voices/queen/reference`,{
  headers:{Cookie:bob.cookie,Range:'bytes=8-11'}}),d1Env);
equal(d1Playback.status,206);
equal(await d1Playback.text(),'WAVE');
audioDb.sql.close(); quotaDb.sql.close();

// Administration is separately authorized; user-supplied roles never grant authority.
env.DB.sql.prepare('INSERT INTO users(id,username,display_name,password_salt,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)')
  .run('admin-test', 'admin-test', '测试管理员', salt, await passwordHash('test-password', salt), 'admin', now());
const admin = await actor('admin-test');
equal((await call('/api/me', {actor:admin})).json.user.role, 'admin');
equal((await call('/api/me', {actor:bob})).json.user.role, 'user');
equal((await call('/api/admin/overview')).response.status, 401);
equal((await call('/api/admin/overview', {actor:bob})).response.status, 403);
equal((await call('/api/admin/jobs', {actor:bob})).response.status, 403);
const adminMutations = [
  ['POST','/api/admin/users',{username:'forbidden',display_name:'禁止创建',password:'test-password'}],
  ['PATCH','/api/admin/users/u2',{active:false}],
  ['DELETE','/api/admin/users/u2',undefined],
  ['POST','/api/admin/users/u2/restore',{}],
  ['PATCH','/api/admin/voices/queen',{hidden:true}],
  ['PUT','/api/admin/settings',{max_text_length:12,accepting_jobs:true}],
  ['POST',`/api/admin/jobs/${one.id}/cancel`,{}],
];
for (const [method,path,body] of adminMutations) {
  equal((await call(path,{method,body,actor:bob})).response.status,403,`${path}: ordinary user blocked`);
  equal((await call(path,{method,body,actor:{cookie:admin.cookie,csrf:''}})).response.status,403,`${path}: CSRF required`);
}
const adminOverview = (await call('/api/admin/overview',{actor:admin})).json;
ok(Array.isArray(adminOverview.users) && Array.isArray(adminOverview.voices));
ok(adminOverview.settings && adminOverview.worker && adminOverview.counts && Array.isArray(adminOverview.audit));
ok(!JSON.stringify(adminOverview).includes('password_hash') && !JSON.stringify(adminOverview).includes('password_salt'));
ok(adminOverview.voices.every(v=>'hidden' in v));
equal((await call('/api/admin/users',{method:'POST',actor:admin,
  body:{username:'managed-user',display_name:'受管理用户',password:'test-password',role:'admin'}})).response.status,400);
equal(env.DB.sql.prepare("SELECT count(*) n FROM users WHERE username='managed-user'").get().n,0);
const createManaged = await call('/api/admin/users',{method:'POST',actor:admin,
  body:{username:'managed-user',display_name:'受管理用户',password:'test-password'}});
ok([200,201].includes(createManaged.response.status));
const managedRow = env.DB.sql.prepare("SELECT * FROM users WHERE username='managed-user'").get();
equal(managedRow.role,'user');
ok(managedRow.password_hash !== 'test-password' && managedRow.password_salt !== salt);
ok(!JSON.stringify(createManaged.json).includes(managedRow.password_hash));
equal((await call('/api/admin/users',{method:'POST',actor:admin,
  body:{username:'managed-user',display_name:'重复用户',password:'test-password'}})).response.status,409);
let managed = await actor('managed-user');
const managedSecond = await actor('managed-user');
equal((await call(`/api/admin/users/${managedRow.id}`,{method:'PATCH',actor:admin,body:{active:false}})).response.status,200);
equal((await call('/api/jobs',{actor:managed})).response.status,401);
equal((await call('/api/jobs',{actor:managedSecond})).response.status,401);
equal((await call(`/api/admin/users/${managedRow.id}`,{method:'PATCH',actor:admin,body:{active:true}})).response.status,200);
equal((await call('/api/jobs',{actor:managed})).response.status,401,'reactivation does not revive a revoked session');
managed = await actor('managed-user');
equal((await call(`/api/admin/users/${managedRow.id}`,{method:'PATCH',actor:admin,body:{password:'reset-password-42'}})).response.status,200);
equal((await call('/api/jobs',{actor:managed})).response.status,401,'password reset revokes sessions');
equal(await passwordHash('reset-password-42',env.DB.sql.prepare('SELECT password_salt FROM users WHERE id=?').get(managedRow.id).password_salt),
  env.DB.sql.prepare('SELECT password_hash FROM users WHERE id=?').get(managedRow.id).password_hash);
// Restore the fixture password through the public administrator API.
equal((await call(`/api/admin/users/${managedRow.id}`,{method:'PATCH',actor:admin,body:{password:'test-password'}})).response.status,200);
managed = await actor('managed-user');
for (const [method,body] of [['PATCH',{active:false}],['PATCH',{password:'changed-password'}],['DELETE',undefined]]) {
  ok([403,409].includes((await call('/api/admin/users/admin-test',{method,body,actor:admin})).response.status),'administrator account protected');
}

// Hidden voices are blocked by catalogue, sample URL and direct job submission,
// while previously queued requests retain access to their worker reference.
const beforeHidden = (await job(managed,'admin-hidden-existing')).json.job;
equal((await call('/api/admin/voices/queen',{method:'PATCH',actor:admin,body:{hidden:true}})).response.status,200);
ok(!(await call('/api/voices',{actor:managed})).json.voices.some(v=>v.id==='queen'));
for (const method of ['GET','HEAD']) equal((await call('/api/voices/queen/reference',{actor:managed,method})).response.status,404);
equal((await job(managed,'admin-hidden-bypass')).response.status,400);
equal((await call('/api/worker/voices/queen/reference',{bearer:env.WORKER_TOKEN})).response.status,200);
const hiddenClaim = (await workerCall('/claim',{worker_id:'mac-a'})).json.job;
equal(hiddenClaim.id,beforeHidden.id);
equal((await call(`/api/admin/jobs/${beforeHidden.id}/cancel`,{method:'POST',actor:admin,body:{}})).response.status,200);
equal((await workerCall(`/jobs/${beforeHidden.id}/heartbeat`,{lease_token:hiddenClaim.lease_token})).json.cancel_requested,true);
equal((await workerCall(`/jobs/${beforeHidden.id}/release`,{lease_token:hiddenClaim.lease_token})).json.job.status,'cancelled');
equal((await call('/api/admin/voices/queen',{method:'PATCH',actor:admin,body:{hidden:false}})).response.status,200);
ok((await call('/api/voices',{actor:managed})).json.voices.some(v=>v.id==='queen'));

// Limits count Unicode code points and are enforced server-side on every request.
equal((await call('/api/admin/settings',{method:'PUT',actor:admin,body:{max_text_length:3,accepting_jobs:true}})).response.status,200);
for (const path of ['/api/voices','/api/jobs']) equal((await call(path,{actor:managed})).json.settings.max_text_length,3);
const unicodeJob = await job(managed,'admin-unicode-valid','😀😀😀');
equal(unicodeJob.response.status,201);
equal((await job(managed,'admin-unicode-too-long','😀😀😀😀')).response.status,400);
equal((await job(managed,'admin-text-too-long','四个字呀')).response.status,400);
for (const max_text_length of [0,301,1.5]) equal((await call('/api/admin/settings',{method:'PUT',actor:admin,body:{max_text_length,accepting_jobs:true}})).response.status,400);
equal((await call('/api/admin/settings',{method:'PUT',actor:admin,body:{max_text_length:300,accepting_jobs:false}})).response.status,200);
equal((await job(managed,'admin-paused')).response.status,503);
equal((await call('/api/jobs',{actor:managed})).json.settings.accepting_jobs,false);
equal((await call('/api/admin/settings',{method:'PUT',actor:admin,body:{max_text_length:300,accepting_jobs:true}})).response.status,200);
equal((await call(`/api/admin/jobs/${unicodeJob.json.job.id}/cancel`,{method:'POST',actor:admin,body:{}})).response.status,200);
equal(env.DB.sql.prepare('SELECT status FROM jobs WHERE id=?').get(unicodeJob.json.job.id).status,'cancelled');

// Deletion is reversible, revokes all sessions and cancels both queued/running jobs.
const deleteRunning = (await job(managed,'admin-delete-running','保留的私密文本')).json.job;
const deleteQueued = (await job(managed,'admin-delete-queued')).json.job;
const deleteClaim = (await workerCall('/claim',{worker_id:'mac-a'})).json.job;
equal(deleteClaim.id,deleteRunning.id);
const deletedSecondSession = await actor('managed-user');
equal((await call(`/api/admin/users/${managedRow.id}`,{method:'DELETE',actor:admin})).response.status,200);
const softDeleted = env.DB.sql.prepare('SELECT active,deleted_at FROM users WHERE id=?').get(managedRow.id);
equal(softDeleted.active,0); ok(softDeleted.deleted_at);
equal((await call('/api/jobs',{actor:managed})).response.status,401);
equal((await call('/api/jobs',{actor:deletedSecondSession})).response.status,401);
equal(env.DB.sql.prepare('SELECT status FROM jobs WHERE id=?').get(deleteQueued.id).status,'cancelled');
equal((await workerCall(`/jobs/${deleteRunning.id}/heartbeat`,{lease_token:deleteClaim.lease_token})).json.cancel_requested,true);
equal((await workerCall(`/jobs/${deleteRunning.id}/release`,{lease_token:deleteClaim.lease_token})).json.job.status,'cancelled');
equal((await call(`/api/admin/users/${managedRow.id}/restore`,{method:'POST',actor:admin,body:{}})).response.status,200);
equal({...env.DB.sql.prepare('SELECT active,deleted_at FROM users WHERE id=?').get(managedRow.id)},{active:0,deleted_at:null});
equal((await call(`/api/admin/users/${managedRow.id}`,{method:'PATCH',actor:admin,body:{active:true}})).response.status,200);
equal((await call('/api/jobs',{actor:deletedSecondSession})).response.status,401);
managed = await actor('managed-user');
equal((await call('/api/jobs',{actor:managed})).response.status,200);
const adminJobs = (await call('/api/admin/jobs',{actor:admin})).json;
ok(Array.isArray(adminJobs.jobs) && adminJobs.jobs.length>0);
for (const row of adminJobs.jobs) for (const key of ['text','lease_token','audio_key','audio_url']) ok(!(key in row),`admin queue omits ${key}`);
ok(!JSON.stringify(adminJobs).includes('保留的私密文本'));
const olderJobs = (await call(`/api/admin/jobs?before=${deleteRunning.id}`,{actor:admin})).json.jobs;
ok(olderJobs.every(row=>row.id<deleteRunning.id));
const finalOverview = (await call('/api/admin/overview',{actor:admin})).json;
ok(finalOverview.audit.length>0);
const auditText = JSON.stringify(env.DB.sql.prepare('SELECT * FROM admin_audit').all());
for (const secret of ['test-password','reset-password-42',managedRow.password_hash,'保留的私密文本']) ok(!auditText.includes(secret),'audit excludes passwords and text');
{
// Queue cap, progress and history regressions.
const pendingIds=[];
for(let i=0;i<3;i++) {const created=await job(managed,`limit-regression-${i}`);equal(created.response.status,201);pendingIds.push(created.json.job.id);}
equal((await job(managed,'limit-regression-over')).response.status,429);
equal((await job(managed,'limit-regression-0')).json.job.id,pendingIds[0],'idempotency still works at cap');
const capClaim=(await workerCall('/claim',{worker_id:'mac-a'})).json.job;
equal(capClaim.id,pendingIds[0]);
equal((await workerCall(`/jobs/${capClaim.id}/heartbeat`,{lease_token:capClaim.lease_token,phase:'generating',completed_segments:2,total_segments:5,elapsed_seconds:42})).response.status,200);
equal((await workerCall(`/jobs/${capClaim.id}/heartbeat`,{lease_token:capClaim.lease_token})).response.status,200,'lease check preserves progress');
equal((await workerCall(`/jobs/${capClaim.id}/heartbeat`,{lease_token:capClaim.lease_token,completed_segments:3})).response.status,400,'partial progress rejected');
const progressJob=(await call(`/api/jobs/${capClaim.id}`,{actor:managed})).json.job;
equal([progressJob.phase,progressJob.completed_segments,progressJob.total_segments,progressJob.elapsed_seconds],['generating',2,5,42]);
equal((await call(`/api/jobs/${capClaim.id}/cancel`,{method:'POST',actor:managed})).response.status,200);
equal((await job(managed,'limit-cancel-not-finished')).response.status,429,'cancelling running job still counts');
await workerCall(`/jobs/${capClaim.id}/release`,{lease_token:capClaim.lease_token});
for(const id of pendingIds.slice(1)) await call(`/api/jobs/${id}/cancel`,{method:'POST',actor:managed});
for(const n of [0,11,1.5]) equal((await call('/api/admin/settings',{method:'PUT',actor:admin,body:{max_text_length:300,accepting_jobs:true,max_pending_jobs:n}})).response.status,400);
equal((await call('/api/admin/settings',{method:'PUT',actor:admin,body:{max_text_length:300,accepting_jobs:true,max_pending_jobs:3}})).response.status,200);
const oldestActive=(await job(managed,'pagination-oldest-active')).json.job;
for(let i=0;i<205;i++) env.DB.sql.prepare("INSERT INTO jobs(user_id,voice_id,text,request_key,created_at,status) VALUES(?,?,?,?,?,'completed')").run(managedRow.id,'queen','历史',`history-${i}`,Date.now()/1000|0);
const firstPage=(await call('/api/jobs',{actor:managed})).json;
equal(firstPage.history_jobs.length,20);ok(firstPage.active_jobs.some(j=>j.id===oldestActive.id),'old queuehead survives 200 history entries');ok(firstPage.next_before);
const nextPage=(await call(`/api/jobs?before=${firstPage.next_before}&voice_id=queen&status=completed`,{actor:managed})).json;
equal(nextPage.history_jobs.length,20);ok(nextPage.history_jobs.every(j=>j.id<firstPage.next_before));
const searchedHistory=(await call('/api/jobs?voice_query='+encodeURIComponent('王母'),{actor:managed})).json;
equal(searchedHistory.history_jobs.length,20);ok(searchedHistory.history_jobs.every(j=>j.voice_name.includes('王母')));
const searchedOlder=(await call(`/api/jobs?voice_query=${encodeURIComponent('王母')}&before=${searchedHistory.next_before}`,{actor:managed})).json;
equal(searchedOlder.history_jobs.length,20);ok(searchedOlder.history_jobs.every(j=>j.id<searchedHistory.next_before));
for(const literal of ['%', '_', '\\', '不存在的角色']) {
  const filtered=(await call('/api/jobs?voice_query='+encodeURIComponent(literal),{actor:managed})).json;
  equal(filtered.history_jobs.length,0,'search wildcard characters are literal');
  ok(filtered.active_jobs.some(j=>j.id===oldestActive.id),'all active requests survive history search');
}
equal((await call('/api/jobs?voice_query='+encodeURIComponent('字'.repeat(81)),{actor:managed})).response.status,400);
equal((await call('/api/jobs?before=NaN',{actor:managed})).response.status,400);
await call(`/api/jobs/${oldestActive.id}/cancel`,{method:'POST',actor:managed});
const restorable=firstPage.history_jobs[0].id;
equal((await call(`/api/jobs/${restorable}`,{actor:managed,method:'DELETE'})).response.status,200);
ok((await call('/api/jobs?deleted=1',{actor:managed})).json.history_jobs.some(j=>j.id===restorable));
equal((await call(`/api/jobs/${restorable}/restore`,{actor:bob,method:'POST',body:{}})).response.status,409);
equal((await call(`/api/jobs/${restorable}/restore`,{actor:managed,method:'POST',body:{}})).response.status,200);

// Competing requests cannot exceed the cap, including the INSERT-time check.
const concurrent=await Promise.all(Array.from({length:6},(_,i)=>job(managed,`concurrent-limit-${i}`)));
equal(concurrent.filter(r=>r.response.status===201).length,3);
equal(env.DB.sql.prepare("SELECT count(*) n FROM jobs WHERE user_id=? AND status IN ('queued','running')").get(managedRow.id).n,3);
for(const result of concurrent.filter(r=>r.response.status===201)) await call(`/api/jobs/${result.json.job.id}/cancel`,{method:'POST',actor:managed});

// Actual D1 reclamation: expired deletion only; preserved samples, live jobs,
// seven-day recovery and unclassified published assets remain untouched.
env.AUDIO_STORAGE='d1'; env.AUDIO_QUOTA_BYTES=512*1024*1024; env.AUDIO=new D1AudioStore(env.DB);
const old=(Date.now()/1000|0)-8*86400;
const expiredKey=`jobs/${restorable}/expired.wav`;
const expiredAudio=await env.AUDIO.put(expiredKey,new Uint8Array(128).fill(8));
env.DB.sql.prepare('UPDATE jobs SET deleted_at=?,audio_key=? WHERE id=?').run(old,expiredKey,restorable);
const protectedReference=await env.AUDIO.put('references/queen.wav',new Uint8Array(64).fill(2));
const unclassified=await env.AUDIO.put('references/old-unknown.wav',new Uint8Array(64).fill(3));
const superseded1=await env.AUDIO.put('unused-version.wav',new Uint8Array(64).fill(4));
const superseded2=await env.AUDIO.put('unused-version.wav',new Uint8Array(64).fill(5));
const recentKey=`jobs/${firstPage.history_jobs[1].id}/recent.wav`;
const recent=await env.AUDIO.put(recentKey,new Uint8Array(64).fill(6));
env.DB.sql.prepare('UPDATE jobs SET deleted_at=?,audio_key=? WHERE id=?').run(Date.now()/1000|0,recentKey,firstPage.history_jobs[1].id);
env.DB.sql.prepare('UPDATE audio_uploads SET created_at=?').run(old);
let preview=(await call('/api/admin/storage/cleanup-preview',{actor:admin})).json;
ok(preview.candidates.some(c=>c.version_id===expiredAudio.version));ok(preview.candidates.some(c=>c.version_id===superseded1.version));
for(const object of [protectedReference,unclassified,superseded2,recent]) ok(!preview.candidates.some(c=>c.version_id===object.version),'protected or unknown object absent from preview');
const usageBefore=preview.storage.used_bytes;
equal(preview.storage.quota_bytes,512*1024*1024);
equal((await call('/api/admin/storage/cleanup',{actor:managed,method:'POST',body:{version_ids:[expiredAudio.version]}})).response.status,403);
const reclaimed=await call('/api/admin/storage/cleanup',{actor:admin,method:'POST',body:{version_ids:[expiredAudio.version,superseded1.version,protectedReference.version,unclassified.version,recent.version]}});
equal(reclaimed.response.status,200);equal(reclaimed.json.reclaimed_versions,2);equal(reclaimed.json.storage.used_bytes,usageBefore-192);
equal(await env.AUDIO.head(expiredKey),null);ok(await env.AUDIO.head('references/queen.wav'));ok(await env.AUDIO.head('references/old-unknown.wav'));ok(await env.AUDIO.head(recentKey));
equal(env.DB.sql.prepare('SELECT count(*) n FROM audio_chunks WHERE version_id=?').get(expiredAudio.version).n,0);
ok(env.DB.sql.prepare('SELECT reclaimed_at FROM jobs WHERE id=?').get(restorable).reclaimed_at);
equal((await call(`/api/jobs/${restorable}/restore`,{actor:managed,method:'POST',body:{}})).response.status,409);
// Revalidate after preview: extending recovery before cleanup protects the audio.
const racedId=firstPage.history_jobs[2].id,racedKey=`jobs/${racedId}/race.wav`;
const raced=await env.AUDIO.put(racedKey,new Uint8Array(64).fill(7));
env.DB.sql.prepare('UPDATE audio_uploads SET created_at=? WHERE version_id=?').run(old,raced.version);
env.DB.sql.prepare('UPDATE jobs SET deleted_at=?,audio_key=? WHERE id=?').run(old,racedKey,racedId);
ok((await call('/api/admin/storage/cleanup-preview',{actor:admin})).json.candidates.some(c=>c.version_id===raced.version));
env.DB.sql.prepare('UPDATE jobs SET deleted_at=NULL WHERE id=?').run(racedId);
equal((await call('/api/admin/storage/cleanup',{actor:admin,method:'POST',body:{version_ids:[raced.version]}})).json.reclaimed_versions,0);
ok(await env.AUDIO.head(racedKey));
// Capacity reservation pauses admission even before 95% when the max output won't fit.
env.AUDIO_QUOTA_BYTES=1024;
equal((await job(managed,'storage-reserved-cap')).response.status,507);
const low=(await call('/api/admin/overview',{actor:admin})).json.storage;
equal(low.accepting_jobs,false);
env.AUDIO_QUOTA_BYTES=512*1024*1024;

// Scheduled cleanup uses identical guards; current published data stays readable.
const scheduledKey='abandoned-scheduled.wav', scheduledOld=await env.AUDIO.put(scheduledKey,new Uint8Array(64).fill(10));
await env.AUDIO.put(scheduledKey,new Uint8Array(64).fill(11));
env.DB.sql.prepare('UPDATE audio_uploads SET created_at=? WHERE version_id=?').run(old,scheduledOld.version);
const promises=[]; await worker.scheduled({},env,{waitUntil:p=>promises.push(p)});await Promise.all(promises);
equal(env.DB.sql.prepare('SELECT count(*) n FROM audio_uploads WHERE version_id=?').get(scheduledOld.version).n,0);
ok(await env.AUDIO.head(scheduledKey));

const guardJob=(await job(managed,'cleanup-active-guard')).json.job;
const guardAudio=await env.AUDIO.put(`jobs/${guardJob.id}/uncommitted.wav`,new Uint8Array(64).fill(12));
env.DB.sql.prepare('UPDATE audio_uploads SET created_at=? WHERE version_id=?').run(old,guardAudio.version);
equal((await call('/api/admin/storage/cleanup',{actor:admin,method:'POST',body:{version_ids:[guardAudio.version]}})).json.reclaimed_versions,0,'active job prefix protects even uncommitted audio');
ok(await env.AUDIO.head(`jobs/${guardJob.id}/uncommitted.wav`));
await call(`/api/jobs/${guardJob.id}/cancel`,{actor:managed,method:'POST'});
const used=env.DB.sql.prepare('SELECT sum(size) n FROM audio_uploads').get().n;
for(const [percent,level] of [[71,'notice'],[86,'warning'],[96,'critical']]) {
  env.AUDIO_QUOTA_BYTES=Math.floor(used*100/percent);
  equal((await call('/api/admin/overview',{actor:admin})).json.storage.level,level);
}
env.AUDIO_QUOTA_BYTES=400*1024*1024;

}
{
// Self-registration creates ordinary users and rotates the anonymous session.
const anonymous = async () => {
  const me=await call('/api/me');
  return {cookie:me.response.headers.get('Set-Cookie').split(';')[0],csrf:me.json.csrf_token};
};
const registerActor=await anonymous();
const request={method:'POST',actor:registerActor,body:{username:'self-registered',password:'self-password-42'},headers:{'CF-Connecting-IP':'registration-success'}};
equal((await call('/api/register',{...request,headers:{...request.headers,Origin:'https://foreign.example'}})).response.status,403);
equal((await call('/api/register',{...request,actor:{...registerActor,csrf:'wrong'}})).response.status,403);
equal((await call('/api/register',{...request,body:{...request.body,role:'admin'}})).response.status,400);
const registered=await call('/api/register',request);
equal(registered.response.status,201);equal(registered.json.authenticated,true);equal(registered.json.user.role,'user');
equal(registered.json.user.display_name,'self-registered');
const fresh={cookie:registered.response.headers.get('Set-Cookie').split(';')[0],csrf:registered.json.csrf_token};
ok(fresh.cookie!==registerActor.cookie);ok(fresh.csrf!==registerActor.csrf);
equal((await call('/api/me',{actor:fresh})).json.user.id,registered.json.user.id);
equal((await call('/api/jobs',{actor:registerActor})).response.status,401,'pre-registration session revoked');
equal((await call('/api/admin/overview',{actor:fresh})).response.status,403);
const stored=env.DB.sql.prepare('SELECT * FROM users WHERE id=?').get(registered.json.user.id);
equal(stored.role,'user');equal(stored.active,1);equal(stored.password_iterations,100000);
ok(stored.password_hash!==request.body.password);equal(stored.password_hash,await passwordHash(request.body.password,stored.password_salt));
const another=await anonymous();
equal((await call('/api/register',{...request,actor:another,body:{...request.body,username:'SELF-REGISTERED'}})).response.status,409,'duplicate is case insensitive');
for(const [i,body] of [{username:'x',password:'valid-password'},{username:'bad name',password:'valid-password'},{username:'valid-name',password:'short'},{username:'valid-name',password:'x'.repeat(129)}].entries()) {
  equal((await call('/api/register',{method:'POST',actor:another,body,headers:{'CF-Connecting-IP':`invalid-register-${i}`}})).response.status,400);
}
const raceActors=await Promise.all([anonymous(),anonymous()]);
const race=await Promise.all(raceActors.map((actor,i)=>call('/api/register',{method:'POST',actor,body:{username:'registration-race',password:'valid-password'},headers:{'CF-Connecting-IP':`register-race-${i}`}})));
equal(race.map(r=>r.response.status).sort(),[201,409]);
equal(env.DB.sql.prepare("SELECT count(*) n FROM users WHERE username='registration-race'").get().n,1);
for(let i=0;i<10;i++) equal((await call('/api/register',{method:'POST',actor:another,body:{username:'x',password:'valid-password'},headers:{'CF-Connecting-IP':'rate-register'}})).response.status,400);
equal((await call('/api/register',{method:'POST',actor:another,body:{username:'would-be-valid',password:'valid-password'},headers:{'CF-Connecting-IP':'rate-register'}})).response.status,429);
equal(env.DB.sql.prepare("SELECT count(*) n FROM users WHERE username='would-be-valid'").get().n,0);
}
env.DB.sql.close();
console.log(`PASS ${checks} checks: FIFO/claims, ownership, sessions, R2/D1 ranges, cancellation/release, D1 chunk publication, resume, concurrent quota reservations, 25MiB query limits, admin permissions/CSRF, user lifecycle, voice visibility, Unicode limits and audit privacy.`);
