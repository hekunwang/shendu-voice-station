"""Transactional private speech queue and login sessions (stdlib only)."""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Store:
    def __init__(self, state_dir: str | Path):
        self.state_dir = Path(state_dir).resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.state_dir / "station.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    salt TEXT NOT NULL, password_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id INTEGER,
                    csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL, voice_id TEXT NOT NULL,
                    text TEXT NOT NULL, request_key TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                    error TEXT, result_path TEXT, duration_seconds REAL,
                    cancel_requested INTEGER NOT NULL DEFAULT 0, deleted_at TEXT,
                    UNIQUE(user_id,request_key),
                    FOREIGN KEY(user_id) REFERENCES users(id)
                );
                CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status,id);
                CREATE INDEX IF NOT EXISTS jobs_user ON jobs(user_id,id);
                CREATE TABLE IF NOT EXISTS worker_status (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    payload TEXT NOT NULL, updated_at TEXT NOT NULL
                );
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=30000")
        try:
            yield db
        finally:
            db.close()

    @staticmethod
    def _password(password: str, salt: str) -> str:
        return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 600_000).hex()

    def create_user(self, username: str, password: str) -> dict:
        username = username.strip()
        if not username or len(username) > 64:
            raise ValueError("用户名需为 1–64 个字符")
        if len(password) < 8 or len(password) > 256:
            raise ValueError("密码需为 8–256 个字符")
        salt = secrets.token_hex(16)
        digest = self._password(password, salt)
        with self.connect() as db:
            try:
                cur = db.execute("INSERT INTO users(username,salt,password_hash,created_at) VALUES (?,?,?,?)",
                                 (username, salt, digest, now()))
            except sqlite3.IntegrityError as exc:
                raise ValueError("用户名已存在") from exc
            return {"id": cur.lastrowid, "username": username}

    def verify_user(self, username: str, password: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        # Equal work for absent users prevents a cheap username timing oracle.
        salt = row["salt"] if row else "00" * 16
        digest = self._password(password, salt)
        if row and hmac.compare_digest(digest, row["password_hash"]):
            return {"id": row["id"], "username": row["username"]}
        return None

    def create_session(self, user_id: int | None = None, hours: float = 168) -> tuple[str, dict]:
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        expires = (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat(timespec="milliseconds")
        with self.connect() as db:
            db.execute("INSERT INTO sessions VALUES (?,?,?,?)",
                       (hashlib.sha256(token.encode()).hexdigest(), user_id, csrf, expires))
        return token, self.get_session(token)

    def get_session(self, token: str | None) -> dict | None:
        if not token or len(token) > 256:
            return None
        with self.connect() as db:
            row = db.execute("""SELECT s.user_id,s.csrf_token,s.expires_at,u.username
                FROM sessions s LEFT JOIN users u ON u.id=s.user_id
                WHERE s.token_hash=? AND s.expires_at>?""",
                (hashlib.sha256(token.encode()).hexdigest(), now())).fetchone()
        return dict(row) if row else None

    def revoke_session(self, token: str | None) -> None:
        if token:
            with self.connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))

    def create_job(self, user_id: int, voice_id: str, text: str, request_key: str) -> dict:
        if not text.strip() or len(text) > 300:
            raise ValueError("文本需为 1–300 个字符")
        if not request_key or len(request_key) > 128:
            raise ValueError("无效请求编号")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT * FROM jobs WHERE user_id=? AND request_key=?", (user_id, request_key)).fetchone()
            if old:
                db.commit()
                if old["deleted_at"]:
                    raise ValueError("该请求已删除，请重新提交")
                result = dict(old)
                result["_created"] = False
                return result
            cur = db.execute("INSERT INTO jobs(user_id,voice_id,text,request_key,created_at) VALUES (?,?,?,?,?)",
                             (user_id, str(voice_id), text, request_key, now()))
            row = db.execute("SELECT * FROM jobs WHERE id=?", (cur.lastrowid,)).fetchone()
            db.commit()
            result = dict(row)
            result["_created"] = True
            return result

    def get_job(self, job_id: int, user_id: int | None = None, include_deleted: bool = False) -> dict | None:
        sql, args = "SELECT * FROM jobs WHERE id=?", [job_id]
        if user_id is not None:
            sql += " AND user_id=?"
            args.append(user_id)
        if not include_deleted:
            sql += " AND deleted_at IS NULL"
        with self.connect() as db:
            row = db.execute(sql, args).fetchone()
        return dict(row) if row else None

    @staticmethod
    def _public_job(row, db) -> dict:
        result = {k: row[k] for k in ("id", "voice_id", "text", "status", "created_at", "started_at",
                  "finished_at", "error", "duration_seconds", "cancel_requested")}
        result["cancel_requested"] = bool(result["cancel_requested"])
        result["visible_status"] = "cancel_pending" if row["status"] == "running" and row["cancel_requested"] else row["status"]
        result["queue_position"] = None
        result["ahead_count"] = None
        if row["status"] == "queued":
            ahead = db.execute("""SELECT COUNT(*) FROM jobs WHERE status='running'
                OR (status='queued' AND deleted_at IS NULL AND cancel_requested=0 AND id<?)""", (row["id"],)).fetchone()[0]
            result["ahead_count"] = ahead
            result["queue_position"] = ahead + 1
        elif row["status"] == "running":
            result["ahead_count"], result["queue_position"] = 0, 1
        result["audio_url"] = f"/api/jobs/{row['id']}/audio" if row["status"] == "completed" else None
        return result

    def list_jobs(self, user_id: int) -> dict:
        with self.connect() as db:
            db.execute("BEGIN")
            rows = db.execute("SELECT * FROM jobs WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC", (user_id,)).fetchall()
            jobs = [self._public_job(row, db) for row in rows]
            counts = {"active_count": db.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0],
                      "queued_count": db.execute("SELECT COUNT(*) FROM jobs WHERE status='queued' AND deleted_at IS NULL AND cancel_requested=0").fetchone()[0]}
            db.commit()
        return {"jobs": jobs, "queue": counts}

    def public_job(self, job_id: int, user_id: int) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=? AND user_id=? AND deleted_at IS NULL", (job_id, user_id)).fetchone()
            return self._public_job(row, db) if row else None

    def cancel_job(self, job_id: int, user_id: int) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=? AND user_id=? AND deleted_at IS NULL", (job_id, user_id)).fetchone()
            if not row:
                db.rollback()
                return False
            if row["status"] == "queued":
                db.execute("UPDATE jobs SET status='cancelled',cancel_requested=1,finished_at=? WHERE id=?", (now(), job_id))
            elif row["status"] == "running":
                db.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (job_id,))
            db.commit()
            return True

    def delete_job(self, job_id: int, user_id: int) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=? AND user_id=? AND deleted_at IS NULL", (job_id, user_id)).fetchone()
            if not row:
                db.rollback()
                return False
            stamp = now()
            db.execute("UPDATE jobs SET deleted_at=? WHERE id=?", (stamp, job_id))
            if row["status"] == "queued":
                db.execute("UPDATE jobs SET status='cancelled',cancel_requested=1,finished_at=? WHERE id=?", (stamp, job_id))
            elif row["status"] == "running":
                db.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (job_id,))
            db.commit()
            return True

    def claim_next(self) -> dict | None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            # One resident inference process; competing workers may not run in parallel.
            if db.execute("SELECT 1 FROM jobs WHERE status='running' LIMIT 1").fetchone():
                db.rollback()
                return None
            row = db.execute("""SELECT * FROM jobs WHERE status='queued' AND
                cancel_requested=0 AND deleted_at IS NULL ORDER BY id LIMIT 1""").fetchone()
            if not row:
                db.rollback()
                return None
            db.execute("UPDATE jobs SET status='running',started_at=?,error=NULL WHERE id=?", (now(), row["id"]))
            row = db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()
            db.commit()
            return dict(row)

    def should_cancel(self, job_id: int) -> bool:
        row = self.get_job(job_id, include_deleted=True)
        return not row or row["status"] != "running" or bool(row["cancel_requested"] or row["deleted_at"])

    def mark_completed(self, job_id: int, result_path: str, duration: float) -> bool:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["status"] != "running":
                db.rollback()
                return False
            if row["cancel_requested"] or row["deleted_at"]:
                db.execute("UPDATE jobs SET status='cancelled',finished_at=? WHERE id=?", (now(), job_id))
                db.commit()
                return False
            db.execute("UPDATE jobs SET status='completed',finished_at=?,result_path=?,duration_seconds=? WHERE id=?",
                       (now(), str(Path(result_path).resolve()), duration, job_id))
            db.commit()
            return True

    def mark_failed(self, job_id: int, error: str) -> None:
        with self.connect() as db:
            db.execute("""UPDATE jobs SET status=CASE WHEN cancel_requested=1 OR deleted_at IS NOT NULL
                THEN 'cancelled' ELSE 'failed' END,finished_at=?,error=? WHERE id=? AND status='running'""",
                (now(), error[:1000], job_id))

    def mark_cancelled(self, job_id: int) -> None:
        with self.connect() as db:
            db.execute("UPDATE jobs SET status='cancelled',cancel_requested=1,finished_at=? WHERE id=? AND status IN ('running','queued')", (now(), job_id))

    def release_job(self, job_id: int) -> bool:
        """Requeue an interrupted claim only after its inference child has stopped.

        The worker's process lock and call ordering provide that guarantee; this
        method deliberately does not revoke a live inference process itself.
        """
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row or row["status"] != "running":
                db.rollback()
                return False
            if row["cancel_requested"] or row["deleted_at"]:
                db.execute("UPDATE jobs SET status='cancelled',finished_at=?,error=NULL WHERE id=?", (now(), job_id))
            else:
                db.execute("""UPDATE jobs SET status='queued',started_at=NULL,finished_at=NULL,
                    error=NULL,result_path=NULL,duration_seconds=NULL WHERE id=?""", (job_id,))
            db.commit()
            return True

    def recover_interrupted(self) -> int:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            count = db.execute("SELECT COUNT(*) FROM jobs WHERE status='running'").fetchone()[0]
            stamp = now()
            db.execute("""UPDATE jobs SET status='cancelled',finished_at=? WHERE status='running'
                AND (cancel_requested=1 OR deleted_at IS NOT NULL)""", (stamp,))
            db.execute("UPDATE jobs SET status='queued',started_at=NULL,error=NULL WHERE status='running'")
            db.commit()
            return count

    def set_worker_status(self, ready: bool, message: str = "", **metadata) -> None:
        stamp = now()
        payload = {**metadata, "ready": bool(ready), "message": message, "updated_at": stamp}
        with self.connect() as db:
            db.execute("INSERT INTO worker_status VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
                       (json.dumps(payload, ensure_ascii=False), stamp))

    def get_worker_status(self) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM worker_status WHERE singleton=1").fetchone()
        if not row:
            return {"ready": False, "message": "生成服务暂未连接", "updated_at": None}
        result = json.loads(row["payload"])
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(row["updated_at"])).total_seconds()
        if age > 90:
            result.update(ready=False, message="生成服务暂未连接")
        return result
