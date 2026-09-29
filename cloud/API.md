# 声馆 HTTP API

Cloudflare Workers 负责账户、D1 队列和私有音频；生成设备主动领取任务并运行语音模型。所有时间戳为 Unix 秒。普通用户只能管理自己的请求；管理员可以管理账户、声线显示和站点设置。

## 会话与错误

先请求 `GET /api/me`，返回 `{authenticated,user,csrf_token}`。匿名用户也取得 CSRF 令牌和 `HttpOnly; Secure; SameSite=Lax` Cookie。所有修改操作（POST、PUT、PATCH、DELETE）必须来自同源并携带 `X-CSRF-Token`；生成设备接口改用 Bearer 认证。

登录和注册成功后都会更换会话 Cookie 与 CSRF，旧会话失效。`user` 包含 `id,username,display_name,role`。密码使用随机 16 字节 salt 和 PBKDF2-HMAC-SHA256，100000 次迭代、32 字节输出；API 不返回密码哈希。

错误统一为 `{error:{code,message}}`。API 和音频返回 `Cache-Control: private, no-store`。常见状态包括：400 输入错误、401 未登录、403 权限或 CSRF 错误、409 状态冲突、429 请求过频或待处理任务达到上限、507 音频容量不足。

## 注册与登录

| 路径 | 方法 | 请求与行为 |
|---|---|---|
| `/api/register` | POST | `{username,password}`；成功返回 201、`{authenticated:true,user,csrf_token}`，并自动登录 |
| `/api/login` | POST | `{username,password}`；成功返回 200 和新的会话信息 |
| `/api/logout` | POST | 注销当前会话 |

注册用户名为 3～40 位，首字符为字母、数字或下划线，其余字符还允许点和短横线；名称按大小写不敏感判重。密码为 8～128 位。显示名称默认等于用户名，注册只能创建普通用户，提交其他 `role` 会被拒绝。不需要验证码或邮箱验证。

注册按 IP 每 10 分钟限制 10 次尝试，登录独立限制为每 10 分钟 20 次。重复用户名返回 `username_exists`；并发注册同名账户也只会产生一个账户。

## 声线与用户请求

| 路径 | 方法 | 请求与返回 |
|---|---|---|
| `/api/voices` | GET | `{voices,worker,settings}`；隐藏声线不会返回 |
| `/api/voices/:id/reference` | GET / HEAD | 登录后读取开放声线参考 WAV，支持 Range |
| `/api/jobs` | POST | `{voice_id,text,request_key}` → 201 `{job}` |
| `/api/jobs` | GET | 全部活动任务，以及一页历史；分页参数见下文 |
| `/api/jobs/:id` | GET | 自己未删除的请求 `{job}` |
| `/api/jobs/:id/cancel` | POST | 排队任务立即取消；运行中任务申请取消，等待生成端退出 |
| `/api/jobs/:id` | DELETE | 移入七天回收站；活动任务同时申请取消 |
| `/api/jobs/:id/restore` | POST | 七天内恢复尚未回收且已停止的请求；恢复不会重新生成 |
| `/api/jobs/:id/audio` | GET / HEAD | 读取自己的 completed 音频，支持 Range；`?download=1` 下载 |

文本按 Unicode 字符计数，长度为 1～`settings.max_text_length`，站点上限可设为 1～300。`request_key` 为 8～128 位字母、数字、下划线或短横线；同一用户重复提交同一标识和内容会返回原请求，标识对应内容不同则返回冲突。

每人待处理任务上限默认 3，可由管理员设为 1～10。排队、运行和运行中取消尚未完成的任务都计入上限；服务端在插入时再次检查，防止并发提交突破限制。任务按照全局 FIFO 顺序领取。

### 历史分页与搜索

`GET /api/jobs` 返回：

```json
{
  "jobs": [],
  "active_jobs": [],
  "history_jobs": [],
  "next_before": null,
  "queue": {"active_count": 0, "queued_count": 0},
  "worker": {},
  "settings": {},
  "storage": {}
}
```

- `active_jobs` 包含自己的全部未删除活动任务，不受历史页大小或搜索条件限制。
- `history_jobs` 每页最多 20 条，按 id 降序；下一页使用返回的 `next_before` 作为 `before` 参数。
- `jobs` 为以上两个数组的拼接，供兼容旧调用方使用。
- `voice_id` 精确筛选历史声线；`voice_query` 按角色名称搜索，最多 80 字，`%`、`_` 等按普通字符处理。
- `status` 可为 queued、running、completed、failed、cancelled。普通历史只含已结束任务；活动任务始终单独返回。
- `deleted=1` 切换到自己的七天回收站，此时 `active_jobs` 为空。

公开任务字段包括 `id,voice_id,voice_name,text,status,cancel_requested,queue_position,created_at,started_at,finished_at,duration_seconds,error,audio_url,phase,completed_segments,total_segments,elapsed_seconds,deleted_at,restore_until`。不返回租约密钥或其他用户的文本、身份。

`queue_position`：运行中为 1；排队为“全局运行数 + 更早排队数 + 1”。运行中取消尚未退出时仍占位。生成进度使用实际阶段与已完成句数，不以时间虚构百分比；终态 `phase` 等于任务状态。

## 管理员接口

以下接口都要求有效管理员会话；修改操作同样要求 CSRF。

| 路径 | 方法 | 请求与行为 |
|---|---|---|
| `/api/admin/overview` | GET | 返回 users、voices、settings、worker、counts、最近 100 条 audit 和 storage |
| `/api/admin/jobs` | GET | 任务管理列表，每页 50 条；`before` 翻页，返回 `next_before`；不含用户文本和音频密钥 |
| `/api/admin/users` | POST | `{username,password,display_name?}` 创建普通用户 |
| `/api/admin/users/:id` | PATCH | `{active:boolean}` 启停，或 `{password}` 重置密码 |
| `/api/admin/users/:id` | DELETE | 软删除用户、撤销其会话并取消待处理任务 |
| `/api/admin/users/:id/restore` | POST | 恢复用户，恢复后仍为停用状态 |
| `/api/admin/voices/:id` | PATCH | `{hidden:boolean}` 控制声线显示及新任务准入 |
| `/api/admin/settings` | PUT | `{max_text_length,accepting_jobs,max_pending_jobs?}`；省略任务上限则保留原值 |
| `/api/admin/jobs/:id/cancel` | POST | 取消活动任务 |
| `/api/admin/storage/cleanup-preview` | GET | 返回可回收候选和 storage |
| `/api/admin/storage/cleanup` | POST | `{version_ids:[...]}`，每次 1～20 项，执行前重新检查保护条件 |

管理员账户不能通过上述普通用户管理入口停用、删除或重置。隐藏声线不影响已经接收的任务完成。管理操作记录审计，排除密码、密码哈希和用户生成文本。

## 生成设备接口

所有 `/api/worker/*` 携带 `Authorization: Bearer <WORKER_TOKEN>`。密钥只存于 Workers secret 和生成设备的私有配置，不能传给浏览器。JSON 请求使用 `Content-Type: application/json`。

1. `POST /api/worker/heartbeat {worker_id,ready,message}` 更新设备状态，建议每 30 秒一次。
2. `POST /api/worker/claim {worker_id}` 原子领取最小 id 的 queued 任务，也支持 GET 的 `worker_id` 参数。返回 `{job,lease_seconds}`；无任务时 job 为 null；已有运行任务时 unavailable 为 busy 或 stale_lease。
3. job 包含 `id,text,voice_id,lease_token,reference_text,reference_seconds,reference_url`。通过 Bearer GET reference_url 获取参考 WAV。
4. `POST /api/worker/jobs/:id/heartbeat {lease_token,phase?,completed_segments?,total_segments?,elapsed_seconds?}` 延长租约，返回 `{cancel_requested,lease_expires_at}`。phase 支持 loading、generating、uploading、retrying。三个进度数值必须一起提供，均为非负整数，已完成数不能超过总数；省略时保留既有进度。
5. `PUT /api/worker/jobs/:id/audio?lease_token=...` 上传 audio/wav，要求 Content-Length。D1 单文件为 44 字节～25 MiB；R2 路径最多 64 MiB。返回 `{audio_key,size}`，密钥路径绑定当前任务和租约。
6. `POST /api/worker/jobs/:id/finish {lease_token,status,audio_key,duration_seconds,error}`。status 为 completed、cancelled 或 failed。完成前必须上传当前租约音频；取消与完成竞态时取消优先。
7. `POST /api/worker/jobs/:id/release {lease_token}` 释放租约。必须先确认原生成进程已停止。普通任务重新 queued 并保留 FIFO id；取消或删除的任务转为 cancelled。

租约到期不会自动抢占运行位。生成设备重启后先确认旧进程退出，再调用 `POST /api/worker/recover {worker_id}`，只恢复相同 worker_id 的过期任务。短暂网络失败应在有效租约内重试，确认租约失效后不得继续发布结果。

参考样本初始化使用 `PUT /api/worker/voices/:id/reference`，只写入 DB 已配置的固定 reference_key；路径及 reference_text 必须非空。单文件 44 字节～2 MiB，要求 audio/wav、Content-Length 和 RIFF/WAVE 标头。返回 `{ok,voice_id,size,sha256}`，不修改台词或 available。新增声线先保持 available=0，上传确认后再开放；管理后台的 hidden 开关与 available 状态独立。

## 音频容量与回收

当未绑定 AUDIO 且 `AUDIO_STORAGE=d1` 时，`d1_audio.js` 提供私有分片存储。当前配置 `AUDIO_QUOTA_BYTES=419430400`，即 **400 MiB** 应用音频配额。它不是数据库服务的总容量；调整前应核对账户和数据库限制并预留索引、队列等开销。

单音频最多 25 MiB、每片 128 KiB。`audio_uploads` 原子预留容量，所有片数和总大小核对后才发布 `audio_objects`。相同内容重试复用确定版本和预留；未完整上传的内容不能播放。Range 读取每批最多 8 片。

`storage` 返回 `used_bytes,quota_bytes,ratio,level,reference_bytes,generated_bytes,reclaimable_bytes,reserved_pending_bytes,accepting_jobs`。ratio 为 0～1 比例；level 在 70%、85%、95% 对应 notice、warning、critical，低于 70% 为 normal。达到 95% 暂停新请求；每个已接收活动任务另按最大输出 25 MiB 预留容量，因此剩余空间不足时可能提前暂停。已有任务仍可继续处理。非 D1 模式不提供这套回收统计。

删除作品后有七天恢复期，期间不释放音频容量。过期后可由管理员预览并实际回收；配置的定时任务每天 UTC 19:00（北京时间 03:00）最多回收 20 个版本。清理会事务性移除对象索引、分片和容量预留，并标记相关请求已回收；回收后不可恢复音频。

回收保护当前参考样本、未删除作品、七天内删除作品和活动任务的上传。只自动处理已明确过期的删除作品或超过保留期的废弃版本；来源未确认的已发布孤立样本不会自动删除。清理预览不等于最终许可，执行时会重新检查，以防恢复或任务状态变化。

已有 AUDIO 绑定优先于 D1。R2 应保持私有；当前物理回收接口仅支持 D1。切换存储前需迁移旧音频，因为默认不会跨两种存储查找文件。

## 初始化与验证

`schema.sql` 用于新数据库；已有数据库按 `migrations/` 顺序迁移。设置 WORKER_TOKEN secret，配置自己的数据库绑定和域名，再部署 worker.js 及 d1_audio.js。初始管理员通过受控数据库初始化创建，公共注册不会赋予管理员角色。

在支持内置 `node:sqlite` 的 Node.js 环境运行：

```sh
node test_worker.mjs
```

当前测试集为 **433 项检查**，覆盖注册、会话轮换、权限、并发限制、历史搜索与分页、FIFO、进度、租约、音频分片、恢复和实际回收。测试使用内存 SQLite 与模拟 R2，不创建持久数据库。部署后仍需验证实际平台运行、浏览器交互及生成设备连接。
