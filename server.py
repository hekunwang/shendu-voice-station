"""Private queue HTTP API; public deployment can put this behind an HTTPS proxy."""
from __future__ import annotations

import argparse
import hmac
import json
import mimetypes
import re
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

try:
    from .store import Store
except ImportError:
    from store import Store

COOKIE = "voice_station_session"
SAFE_VOICE_FIELDS = ("id", "name", "description", "sample_text", "sample_duration_seconds",
                     "reference_seconds", "available", "group", "sample_count", "source", "character_name")


class APIError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message


class StationServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, config: dict):
        self.config = config
        self.store = Store(config["state_dir"])
        catalog = json.loads(Path(config["voices_path"]).read_text())
        catalog = catalog.get("voices", []) if isinstance(catalog, dict) else catalog
        self.voices = {str(v["id"]): v for v in catalog}
        self.ui_dir = Path(config.get("ui_dir", Path(__file__).parent / "ui")).resolve()
        self.attempts = {}
        self.attempts_lock = threading.Lock()
        host, port = config.get("host", "127.0.0.1"), int(config.get("port", 8786))
        self.public_origin = config.get("public_origin", "").rstrip("/")
        origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}", f"http://[::1]:{port}"}
        if host not in ("0.0.0.0", "::", "127.0.0.1", "localhost"):
            origins.add(f"http://{host}:{port}")
        if self.public_origin:
            origins.add(self.public_origin)
        self.origins = origins
        self.hosts = {urlsplit(origin).netloc for origin in origins}
        super().__init__((host, port), Handler)
        # Port 0 is useful for meaningful HTTP integration tests.
        if port == 0:
            actual = self.server_address[1]
            self.origins.update((f"http://127.0.0.1:{actual}", f"http://localhost:{actual}"))
            self.hosts.update((f"127.0.0.1:{actual}", f"localhost:{actual}"))


class Handler(BaseHTTPRequestHandler):
    server: StationServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        # Never log request bodies, cookies, credentials or query strings.
        print(f"{self.log_date_time_string()} {self.command} {urlsplit(self.path).path} {args[1] if len(args)>1 else ''}", flush=True)

    def _json(self, payload, status=200, cookie=None):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self._headers("application/json; charset=utf-8", len(data))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def _headers(self, content_type, size):
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'")

    def _cookie(self, token, clear=False):
        flags = "; Path=/; HttpOnly; SameSite=Strict"
        if self.server.public_origin.startswith("https://"):
            flags += "; Secure"
        return f"{COOKIE}={token}; Max-Age={'0' if clear else '604800'}" + flags

    def _session(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None, None
        token = cookie[COOKIE].value if COOKIE in cookie else None
        return token, self.server.store.get_session(token)

    def _user(self):
        token, session = self._session()
        if not session or not session["user_id"]:
            raise APIError(401, "请先登录")
        return token, session

    def _csrf(self):
        origin = self.headers.get("Origin")
        if origin and origin not in self.server.origins:
            raise APIError(403, "请求来源不被允许")
        token, session = self._session()
        provided = self.headers.get("X-CSRF-Token", "")
        if not session or not provided or not hmac.compare_digest(provided, session["csrf_token"]):
            raise APIError(403, "页面会话已更新，请刷新后重试")
        return token, session

    def _body(self):
        if self.headers.get("Transfer-Encoding"):
            raise APIError(400, "不支持的请求编码")
        if self.headers.get_content_type() != "application/json":
            raise APIError(415, "请求需使用 JSON")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise APIError(400, "无效请求长度")
        if length < 1 or length > 16_384:
            raise APIError(413, "请求内容过大或为空")
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            raise APIError(400, "无效 JSON")
        if not isinstance(payload, dict):
            raise APIError(400, "无效请求")
        return payload

    def _serve_file(self, path: Path, download_name=None):
        if not path.is_file():
            raise APIError(404, "文件暂不可用")
        size = path.stat().st_size
        self.send_response(200)
        self._headers(mimetypes.guess_type(path.name)[0] or "application/octet-stream", size)
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        with path.open("rb") as source:
            while chunk := source.read(64 * 1024):
                self.wfile.write(chunk)

    def _safe_job(self, job_id, user_id):
        job = self.server.store.get_job(int(job_id), user_id)
        if not job:
            raise APIError(404, "请求不存在")
        return job

    def _handle(self):
        if self.headers.get("Host") not in self.server.hosts:
            raise APIError(403, "请求地址不被允许")
        path = urlsplit(self.path).path
        store = self.server.store
        if self.command == "GET" and path == "/api/me":
            _, session = self._session()
            cookie = None
            if not session:
                token, session = store.create_session(hours=1)
                cookie = self._cookie(token)
            self._json({"authenticated": bool(session["user_id"]),
                        "user": {"id": session["user_id"], "username": session["username"]} if session["user_id"] else None,
                        "csrf_token": session["csrf_token"]}, cookie=cookie)
            return
        if self.command in ("POST", "DELETE"):
            token, session = self._csrf()
            if path == "/api/login" and self.command == "POST":
                body = self._body()
                username, password = body.get("username", ""), body.get("password", "")
                if not isinstance(username, str) or not isinstance(password, str) or len(username)>64 or len(password)>256:
                    raise APIError(400, "无效登录信息")
                ip = self.client_address[0]
                with self.server.attempts_lock:
                    attempts = [stamp for stamp in self.server.attempts.get(ip, []) if stamp > time.monotonic()-60]
                    self.server.attempts[ip] = attempts
                    if len(attempts) >= 10:
                        raise APIError(429, "尝试次数过多，请稍后重试")
                    attempts.append(time.monotonic())
                user = store.verify_user(username, password)
                if not user:
                    raise APIError(401, "用户名或密码错误")
                store.revoke_session(token)
                fresh, session = store.create_session(user["id"])
                self._json({"authenticated": True, "user": user, "csrf_token": session["csrf_token"]}, cookie=self._cookie(fresh))
                return
            if not session["user_id"]:
                raise APIError(401, "请先登录")
            user_id = session["user_id"]
            if path == "/api/logout" and self.command == "POST":
                self._body()
                store.revoke_session(token)
                self._json({"ok": True}, cookie=self._cookie("", clear=True))
                return
            if path == "/api/jobs" and self.command == "POST":
                body = self._body()
                voice_id, text, key = body.get("voice_id"), body.get("text"), body.get("request_key")
                if not all(isinstance(v, str) for v in (voice_id, text, key)):
                    raise APIError(400, "无效请求参数")
                voice = self.server.voices.get(voice_id)
                if not voice or voice.get("available") is not True:
                    raise APIError(400, "该声线尚未开放")
                row = store.create_job(user_id, voice_id, text, key)
                self._json({"job": store.public_job(row["id"], user_id)}, status=201 if row["_created"] else 200)
                return
            match = re.fullmatch(r"/api/jobs/(\d+)(/cancel)?", path)
            if match:
                job_id = int(match[1])
                if self.command == "POST" and match[2]:
                    self._body()
                    if not store.cancel_job(job_id, user_id):
                        raise APIError(404, "请求不存在")
                    self._json({"job": store.public_job(job_id, user_id)})
                    return
                if self.command == "DELETE" and not match[2]:
                    if not store.delete_job(job_id, user_id):
                        raise APIError(404, "请求不存在")
                    self._json({"ok": True})
                    return
            raise APIError(404, "接口不存在")
        if path.startswith("/api/"):
            _, session = self._user()
            user_id = session["user_id"]
            if self.command == "GET" and path == "/api/voices":
                voices = [{k: v[k] for k in SAFE_VOICE_FIELDS if k in v} for v in self.server.voices.values()]
                for voice in voices:
                    voice["reference_url"] = f"/api/voices/{voice['id']}/reference" if voice.get("available") else None
                self._json({"voices": voices})
                return
            if self.command == "GET" and path == "/api/jobs":
                payload = store.list_jobs(user_id)
                payload["worker"] = store.get_worker_status()
                self._json(payload)
                return
            match = re.fullmatch(r"/api/jobs/(\d+)/audio", path)
            if self.command == "GET" and match:
                job = self._safe_job(match[1], user_id)
                if job["status"] != "completed" or not job["result_path"]:
                    raise APIError(409, "音频尚未生成")
                download = parse_qs(urlsplit(self.path).query).get("download") == ["1"]
                self._serve_file(Path(job["result_path"]), f"voice-job-{job['id']}.wav" if download else None)
                return
            match = re.fullmatch(r"/api/voices/([^/]+)/reference", path)
            if self.command == "GET" and match:
                voice = self.server.voices.get(match[1])
                ref = voice and (voice.get("reference_path") or voice.get("sample_path"))
                if not voice or not voice.get("available") or not ref:
                    raise APIError(404, "原声样本暂不可用")
                self._serve_file(Path(ref))
                return
            raise APIError(404, "接口不存在")
        if self.command == "GET":
            # No arbitrary file access, directory browsing, or guessed database serving.
            static = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js",
                      "/style.css": "style.css", "/styles.css": "styles.css", "/portraits.json": "portraits.json"}
            name = static.get(path)
            if re.fullmatch(r"/portraits/[a-f0-9]{16,64}\.webp", path):
                name = path.lstrip("/")
            if name:
                self._serve_file(self.server.ui_dir / name)
                return
        raise APIError(404, "页面不存在")

    def _dispatch(self):
        try:
            self._handle()
        except APIError as exc:
            # Closing after a rejected body avoids parsing unread bytes as another request.
            self.close_connection = True
            self._json({"error": exc.message}, exc.status)
        except ValueError as exc:
            self.close_connection = True
            self._json({"error": str(exc)}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.close_connection = True
            self._json({"error": "服务暂时无法处理此请求"}, 500)

    do_GET = _dispatch
    do_POST = _dispatch
    do_DELETE = _dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    server = StationServer(config)
    print(f"Voice station: http://{server.server_address[0]}:{server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
