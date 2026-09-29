"""Outbound-only Mac worker, local SQLite or Cloudflare D1/R2 queue."""
from __future__ import annotations

import argparse
import fcntl
import json
from pathlib import Path
import queue
import secrets
import signal
import subprocess
import sys
import threading
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError

from store import Store


class LeaseLost(Exception):
    pass


class LocalQueue:
    def __init__(self, config):
        self.store = Store(config["state_dir"])
        voices = json.loads(Path(config["voices_path"]).read_text())["voices"]
        self.voices = {v["id"]: v for v in voices}
        for voice in self.voices.values():
            if voice.get("available"):
                for field in ("reference_path", "reference_text", "reference_sha256"):
                    if not voice.get(field):
                        raise ValueError(f"Incomplete voice catalog: {voice['id']} / {field}")

    def heartbeat(self, ready, message):
        self.store.set_worker_status(ready, message, model="VoxCPM2")

    def recover(self):
        self.store.recover_interrupted()

    def next(self):
        job = self.store.claim_next()
        if job:
            voice = self.voices.get(job["voice_id"])
            if not voice or not voice.get("available"):
                self.store.mark_failed(job["id"], "该声线暂不可用")
                return None
            for key in ("reference_path", "reference_text", "reference_sha256"):
                job[key] = voice[key]
        return job

    def check(self, job, progress=None):
        return self.store.should_cancel(job["id"])

    def release(self, job):
        self.store.release_job(job["id"])

    def finish(self, job, result):
        if result["status"] == "completed":
            self.store.mark_completed(job["id"], result["path"], result["duration_seconds"])
        elif result["status"] == "cancelled":
            self.store.mark_cancelled(job["id"])
        else:
            self.store.mark_failed(job["id"], result.get("error", "语音生成失败，请重试"))


class CloudQueue:
    def __init__(self, config):
        self.base = config["cloud_url"].rstrip("/")
        self.token = config["worker_token"]
        self.worker_id = config["worker_id"]
        self.references = Path(config["output_root"]) / "references"
        self.references.mkdir(parents=True, exist_ok=True)

    def request(self, path, data=None, method="POST", binary=False):
        body = data if binary else json.dumps(data or {}, ensure_ascii=False).encode()
        headers = {"Authorization": "Bearer " + self.token,
                   "User-Agent": "ShenduVoiceStation/1.0", "Accept": "application/json, audio/wav",
                   "Content-Type": "audio/wav" if binary else "application/json"}
        if method == "GET":
            body = None
        try:
            with urlopen(Request(self.base + path, data=body, headers=headers, method=method), timeout=45) as reply:
                payload = reply.read()
                return payload if binary else json.loads(payload)
        except HTTPError as exc:
            if exc.code == 409:
                try:
                    error = json.loads(exc.read()).get("error", {})
                    if error.get("code") == "lease_lost":
                        raise LeaseLost("The previous attempt no longer owns this job") from None
                except (ValueError, AttributeError):
                    pass
            raise

    def heartbeat(self, ready, message):
        self.request("/api/worker/heartbeat", {"ready": ready, "message": message, "worker_id": self.worker_id})

    def recover(self):
        self.request("/api/worker/recover", {"worker_id": self.worker_id})

    def next(self):
        result = self.request("/api/worker/claim", {"worker_id": self.worker_id})
        job = result.get("job")
        if job:
            job["_lease_deadline"] = time.monotonic() + result.get("lease_seconds", 300) - 10
            # Each attempt gets its own reference; no concurrent overwrite or stale text/audio pair.
            path = self.references / f"{job['id']}-{job['lease_token']}.wav"
            try:
                path.write_bytes(self.request(job["reference_url"], method="GET", binary=True))
            except Exception:
                try:
                    self.release(job)
                except Exception:
                    pass
                raise
            job["reference_path"] = str(path)
        return job

    def check(self, job, progress=None):
        if time.monotonic() >= job.get("_lease_deadline", float("inf")):
            raise LeaseLost("The task lease expired during a connection outage")
        started = time.monotonic()
        result = self.request(f"/api/worker/jobs/{job['id']}/heartbeat", {"lease_token": job["lease_token"], **(progress or {})})
        # Use server expiration when available and subtract a safety margin.
        remaining = max(0, result.get("lease_expires_at", time.time() + 300) - time.time() - 10)
        job["_lease_deadline"] = started + remaining
        return bool(result.get("cancel_requested"))

    def release(self, job):
        self.request(f"/api/worker/jobs/{job['id']}/release", {"lease_token": job["lease_token"]})

    def finish(self, job, result):
        payload = {"lease_token": job["lease_token"], "status": result["status"]}
        if result["status"] == "completed":
            if self.check(job, result.get("progress")):
                payload["status"] = "cancelled"
            else:
                try:
                    uploaded = result.get("_uploaded")
                    if not uploaded:
                        uploaded = self.request(f"/api/worker/jobs/{job['id']}/audio?lease_token={job['lease_token']}",
                                            Path(result["path"]).read_bytes(), method="PUT", binary=True)
                        uploaded = json.loads(uploaded)
                        result["_uploaded"] = uploaded
                    payload.update(audio_key=uploaded["audio_key"], duration_seconds=result["duration_seconds"])
                except HTTPError as exc:
                    if exc.code not in (413, 415, 507):
                        raise
                    payload.update(status="failed", error="音频存储已满，请联系管理员" if exc.code == 507
                                   else "生成的音频超出存储限制，请缩短文字后重试")
        elif result["status"] == "failed":
            payload["error"] = result.get("error", "语音生成失败，请重试")
        self.request(f"/api/worker/jobs/{job['id']}/finish", payload)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config_path = str(Path(args.config).resolve())
    config = json.loads(Path(config_path).read_text())
    output_root = Path(config["output_root"])
    output_root.mkdir(parents=True, exist_ok=True)
    # A child inherits this lock, so a crashed parent cannot leave an orphan model
    # and let another worker load a second copy or recover its still-running job.
    lock = (output_root / "worker.lock").open("a+")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("已有语音生成进程运行，请先停止原进程")
    backend = CloudQueue(config) if config.get("cloud_url") else LocalQueue(config)
    backend.recover()
    stop = threading.Event()
    status = {"ready": False, "message": "VoxCPM2 正在加载", "job": None, "cancel_file": None}
    status_lock = threading.Lock()
    messages = queue.Queue()
    process = None

    def terminate_runner():
        nonlocal process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

    def start_runner():
        nonlocal process, messages
        terminate_runner()
        messages = queue.Queue()
        process = subprocess.Popen([sys.executable, "-u", str(Path(__file__).with_name("voxcpm_runner.py")),
                                    "--config", config_path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=None, text=True, bufsize=1, pass_fds=(lock.fileno(),))
        child, inbox = process, messages
        def read_events():
            try:
                for line in child.stdout:
                    if line.startswith("VOICE_EVENT "):
                        payload = json.loads(line[len("VOICE_EVENT "):])
                        if not isinstance(payload, dict) or "type" not in payload:
                            raise ValueError("Invalid runner event")
                        inbox.put(payload)
                    else:
                        print(line.rstrip(), flush=True)
            finally:
                inbox.put({"type": "exit"})
        threading.Thread(target=read_events, daemon=True).start()
        with status_lock:
            status.update(ready=False, phase="loading", message="VoxCPM2 正在加载")
        deadline = time.monotonic() + float(config.get("model_load_timeout_seconds", 300))
        while not stop.is_set():
            if time.monotonic() >= deadline:
                terminate_runner()
                raise TimeoutError("模型加载超时")
            try:
                item = inbox.get(timeout=min(1, max(.01, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if item["type"] == "exit":
                raise RuntimeError("VoxCPM2 生成进程退出")
            if item["type"] == "ready":
                with status_lock:
                    status.update(ready=True, phase="generating" if status["job"] else "idle",
                                  message="VoxCPM2 已就绪")
                print("MODEL_READY", flush=True)
                return
        raise InterruptedError("服务正在停止")

    def heartbeat():
        failures = 0
        while not stop.is_set():
            with status_lock:
                ready, message, job, cancel_file = (status[k] for k in ("ready", "message", "job", "cancel_file"))
                progress = {key: status.get(key, 0) for key in ("phase", "completed_segments", "total_segments")}
                progress["elapsed_seconds"] = round(time.monotonic() - status.get("began", time.monotonic()))
            try:
                # Renew the task first: global worker presence must not block its lease.
                if job and backend.check(job, progress):
                    Path(cancel_file).touch()
                backend.heartbeat(ready, message)
                failures = 0
            except LeaseLost:
                if job:
                    job["_lease_lost"] = True
                    Path(cancel_file).touch()
            except Exception as exc:
                failures += 1
                print(f"HEARTBEAT_UNAVAILABLE {type(exc).__name__}", flush=True)
                if job and time.monotonic() >= job.get("_lease_deadline", float("inf")):
                    job["_lease_lost"] = True
                    Path(cancel_file).touch()
            stop.wait(min(20, 5 * 2 ** min(failures - 1, 2)) if failures else 15)

    threading.Thread(target=heartbeat, daemon=True).start()

    def request_stop(signum, frame):
        stop.set()
        with status_lock:
            if status["cancel_file"]:
                Path(status["cancel_file"]).touch()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        start_runner()
        recovered_at = 0.0
        while not stop.is_set():
            try:
                if config.get("cloud_url") and time.monotonic() - recovered_at > 60:
                    backend.recover()
                    recovered_at = time.monotonic()
                job = backend.next()
            except Exception as exc:
                print(f"QUEUE_UNAVAILABLE {type(exc).__name__}", flush=True)
                stop.wait(5)
                continue
            if not job:
                if process.poll() is not None:
                    raise RuntimeError("VoxCPM2 生成进程退出")
                stop.wait(float(config.get("poll_seconds", 10 if config.get("cloud_url") else 2)))
                continue
            folder = output_root / f"job-{job['id']}-{secrets.token_hex(8)}"
            folder.mkdir(parents=True, exist_ok=True)
            cancel_file = folder / "cancel.requested"
            job.update(output_dir=str(folder), cancel_file=str(cancel_file), seed=secrets.randbelow(2**31))
            with status_lock:
                status.update(job=job, cancel_file=str(cancel_file), message="VoxCPM2 正在生成",
                              phase="generating", completed_segments=0, total_segments=0, began=time.monotonic())
            retry_marker = output_root / f"job-{job['id']}-watchdog.json"
            retries = json.loads(retry_marker.read_text()).get("retries", 0) if retry_marker.exists() else 0
            while True:
                process.stdin.write(json.dumps(job, ensure_ascii=False) + "\n")
                process.stdin.flush()
                print(f"JOB_STARTED {job['id']}", flush=True)
                last_progress = time.monotonic()
                while True:
                    if time.monotonic() >= job.get("_lease_deadline", float("inf")):
                        job["_lease_lost"] = True
                    if stop.is_set() or job.get("_lease_lost") or cancel_file.exists():
                        terminate_runner()
                        item = {"status": "interrupted"}
                        break
                    try:
                        item = messages.get(timeout=1)
                    except queue.Empty:
                        if time.monotonic() - last_progress < float(config.get("sentence_timeout_seconds", 600)):
                            continue
                        item = {"type": "timeout"}
                    if item["type"] in ("segment", "progress"):
                        last_progress = time.monotonic()
                        with status_lock:
                            status.update(completed_segments=item.get("completed_segments", item.get("index", -1) + 1),
                                          total_segments=item.get("total", 0))
                        continue
                    if item["type"] in ("exit", "timeout"):
                        terminate_runner()
                        if retries < 1:
                            retries += 1
                            retry_marker.write_text(json.dumps({"retries": retries}))
                            try:
                                start_runner()
                            except (TimeoutError, RuntimeError):
                                item = {"type": "result", "status": "failed", "error": "生成设备重启失败，请稍后重试"}
                                break
                            with status_lock:
                                status.update(completed_segments=0, total_segments=0)
                            item = {"status": "retry"}
                        else:
                            item = {"type": "result", "status": "failed", "error": "语音生成超时，已重试一次，请缩短文本后重试"}
                        break
                    if item["type"] == "result":
                        break
                if item.get("status") != "retry":
                    break
            with status_lock:
                status.update(phase="uploading", message="正在保存生成结果")
                item["progress"] = {"phase": "uploading",
                                    "completed_segments": status.get("completed_segments", 0),
                                    "total_segments": status.get("total_segments", 0),
                                    "elapsed_seconds": round(time.monotonic() - status["began"])}
            # Keep the same finished WAV through transient upload/finalization errors.
            failures = 0
            while True:
                try:
                    if job.get("_lease_lost"):
                        item = {"status": "lease_lost"}
                    elif cancel_file.exists() or stop.is_set() or item["status"] == "interrupted":
                        backend.release(job)
                        item = {"status": "interrupted"}
                    else:
                        backend.finish(job, item)
                    break
                except LeaseLost:
                    item = {"status": "lease_lost"}
                    break
                except Exception as exc:
                    print(f"FINISH_UNAVAILABLE {type(exc).__name__}", flush=True)
                    failures += 1
                    if time.monotonic() >= job.get("_lease_deadline", float("inf")):
                        job["_lease_lost"] = True
                    if stop.wait(min(20, 5 * 2 ** min(failures - 1, 2))):
                        raise RuntimeError("生成结果等待恢复连接")
            print(f"JOB_FINISHED {job['id']} {item['status']}", flush=True)
            with status_lock:
                status.update(job=None, cancel_file=None, phase="idle", message="VoxCPM2 已就绪")
            if not stop.is_set() and process.poll() is not None:
                start_runner()
    finally:
        stop.set()
        terminate_runner()
        with status_lock:
            interrupted_job = status["job"]
        if interrupted_job:
            try:
                backend.release(interrupted_job)
            except Exception:
                # Old runner has exited; next launch recovers its same FIFO id.
                pass
        try:
            backend.heartbeat(False, "生成服务已停止，任务将等待重新连接")
        except Exception:
            pass


if __name__ == "__main__":
    main()
