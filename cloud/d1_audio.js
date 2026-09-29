/* R2-like private storage: publish the manifest only after all chunks exist. */
export const D1_CHUNK_BYTES = 128 * 1024;
export const D1_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const D1_AUDIO_QUOTA_BYTES = 512 * 1024 * 1024;
const WRITE_GROUP = 12, READ_GROUP = 8;
const encode = new TextEncoder();
export class StorageError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const abort = (status, code, message) => { throw new StorageError(status, code, message); };
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || [];
const execute = (db, sql, ...args) => db.prepare(sql).bind(...args).run();

export class D1AudioStore {
  constructor(db, {quotaBytes = D1_AUDIO_QUOTA_BYTES, maxObjectBytes = D1_MAX_AUDIO_BYTES} = {}) {
    this.db = db;
    this.quotaBytes = Math.min(D1_AUDIO_QUOTA_BYTES, Math.max(1, quotaBytes));
    this.maxObjectBytes = Math.min(D1_MAX_AUDIO_BYTES, Math.max(1, maxObjectBytes));
  }
  async head(key) {
    const value = await first(this.db, `SELECT u.*,o.published_at FROM audio_objects o
      JOIN audio_uploads u ON u.version_id=o.version_id WHERE o.object_key=?1`, key);
    if (!value) return null;
    let metadata = {}; try { metadata = JSON.parse(value.custom_metadata); } catch {}
    return {key, version: value.version_id, size: value.size, etag: value.sha256, httpEtag: `"${value.sha256}"`,
      uploaded: new Date(value.published_at * 1000), httpMetadata: {contentType: value.content_type}, customMetadata: metadata};
  }
  async put(key, body, options = {}) {
    if (typeof key !== 'string' || !key || key.length > 300) abort(400, 'audio_key_invalid', '音频存储标识不正确');
    let bytes;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader(), parts = []; let total = 0;
      try {
        for (;;) {
          const {value, done} = await reader.read(); if (done) break;
          total += value.byteLength;
          if (total > this.maxObjectBytes) { await reader.cancel(); abort(413, 'audio_size_invalid', 'D1 版本每段音频最多 25 MiB，请缩短文字'); }
          parts.push(value);
        }
      } finally { reader.releaseLock(); }
      bytes = new Uint8Array(total); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    } else bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (!bytes.length || bytes.length > this.maxObjectBytes) abort(413, 'audio_size_invalid', 'D1 版本每段音频最多 25 MiB，请缩短文字');
    const hash = await digest(bytes), current = await this.head(key);
    if (current?.etag === hash) return current;
    // Deterministic id resumes identical uploads without reserving extra quota.
    const version = await digest(encode.encode(`${key}\0${hash}`));
    const count = Math.ceil(bytes.length / D1_CHUNK_BYTES);
    const contentType = options.httpMetadata?.contentType || 'audio/wav';
    const metadata = JSON.stringify(options.customMetadata || {});
    if (metadata.length > 1024 || contentType.length > 100) abort(400, 'audio_metadata_invalid', '音频信息过长');
    await execute(this.db, `INSERT INTO audio_uploads(version_id,object_key,size,sha256,chunk_count,content_type,custom_metadata,created_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8
      WHERE (SELECT coalesce(sum(size),0) FROM audio_uploads)+?3<=?9
      ON CONFLICT(version_id) DO NOTHING`, version, key, bytes.length, hash, count, contentType, metadata, Math.floor(Date.now()/1000), this.quotaBytes);
    const reserved = await first(this.db, 'SELECT size,sha256 FROM audio_uploads WHERE version_id=?1', version);
    if (!reserved) abort(507, 'audio_quota_exceeded', `音频存储已达到 ${Math.floor(this.quotaBytes/1024/1024)} MiB 上限，请联系管理员清理回收站或扩容`);
    if (reserved.size !== bytes.length || reserved.sha256 !== hash) abort(409, 'audio_reservation_conflict', '音频上传信息冲突');
    for (let start = 0; start < count; start += WRITE_GROUP) {
      const parameters = [version], values = [];
      for (let index = start; index < Math.min(count, start + WRITE_GROUP); index++) {
        const chunk = bytes.slice(index * D1_CHUNK_BYTES, Math.min(bytes.length, (index + 1) * D1_CHUNK_BYTES));
        const ib = parameters.length + 1; parameters.push(index);
        const db = parameters.length + 1; parameters.push(chunk.buffer);
        values.push(`(?1,?${ib},?${db})`);
      }
      // <=25 parameters, <=12 chunks; even 25MiB fits D1 Free's 50-query cap.
      await execute(this.db, `INSERT INTO audio_chunks(version_id,chunk_index,data) VALUES ${values.join(',')}
        ON CONFLICT(version_id,chunk_index) DO NOTHING`, ...parameters);
    }
    const published = await first(this.db, `INSERT INTO audio_objects(object_key,version_id,published_at)
      SELECT u.object_key,u.version_id,?2 FROM audio_uploads u WHERE u.version_id=?1
        AND (SELECT count(*) FROM audio_chunks WHERE version_id=?1)=u.chunk_count
        AND (SELECT coalesce(sum(length(data)),0) FROM audio_chunks WHERE version_id=?1)=u.size
        AND (SELECT min(chunk_index) FROM audio_chunks WHERE version_id=?1)=0
        AND (SELECT max(chunk_index) FROM audio_chunks WHERE version_id=?1)=u.chunk_count-1
      ON CONFLICT(object_key) DO UPDATE SET version_id=excluded.version_id,published_at=excluded.published_at
      RETURNING object_key`, version, Math.floor(Date.now()/1000));
    if (!published) abort(500, 'audio_upload_incomplete', '音频上传不完整，请重试同一个文件');
    return this.head(key);
  }
  async get(key, options = {}) {
    const metadata = await this.head(key); if (!metadata) return null;
    const offset = options?.range?.offset ?? 0;
    const length = Math.min(options?.range?.length ?? metadata.size - offset, metadata.size - offset);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset >= metadata.size) abort(416, 'range_invalid', '音频范围不正确');
    const startIndex = Math.floor(offset / D1_CHUNK_BYTES), endIndex = Math.floor((offset + length - 1) / D1_CHUNK_BYTES);
    const database = this.db; let nextIndex = startIndex;
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          if (nextIndex > endIndex) { controller.close(); return; }
          const groupEnd = Math.min(endIndex, nextIndex + READ_GROUP - 1);
          const chunks = await all(database, `SELECT chunk_index,data FROM audio_chunks
            WHERE version_id=?1 AND chunk_index BETWEEN ?2 AND ?3 ORDER BY chunk_index`, metadata.version, nextIndex, groupEnd);
          if (chunks.length !== groupEnd - nextIndex + 1) abort(500, 'audio_incomplete', '音频分片不完整');
          for (const chunk of chunks) {
            const bytes = chunk.data instanceof Uint8Array ? chunk.data : new Uint8Array(chunk.data);
            const chunkStart = chunk.chunk_index * D1_CHUNK_BYTES;
            const lo = Math.max(0, offset - chunkStart), hi = Math.min(bytes.length, offset + length - chunkStart);
            if (hi > lo) controller.enqueue(bytes.slice(lo, hi));
          }
          nextIndex = groupEnd + 1; if (nextIndex > endIndex) controller.close();
        } catch (error) { controller.error(error); }
      },
    });
    return {...metadata, body: stream, range: options?.range ? {offset, length} : undefined};
  }
}
