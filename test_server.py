import http.client
import json
import threading

import pytest

from server import StationServer


@pytest.fixture
def api(tmp_path):
    sample = tmp_path / "sample.wav"
    sample.write_bytes(b"RIFF-test-original")
    voices = tmp_path / "voices.json"
    voices.write_text(json.dumps({"voices": [{"id": "female", "name": "女主角", "available": True,
        "reference_path": str(sample), "sample_text": "原声文本"},
        {"id": "unavailable", "name": "未验收人物", "available": False}]}))
    server = StationServer({"state_dir": str(tmp_path / "state"), "voices_path": str(voices), "port": 0})
    server.store.create_user("alice", "alice-password")
    server.store.create_user("bob", "bob-password")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)


class Client:
    def __init__(self, server):
        self.server, self.cookie, self.csrf = server, "", ""

    def request(self, method, path, body=None, *, csrf=True, origin=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1])
        headers = {"Cookie": self.cookie}
        if csrf:
            headers["X-CSRF-Token"] = self.csrf
        if origin:
            headers["Origin"] = origin
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, json.dumps(body).encode() if body is not None else None, headers)
        response = connection.getresponse()
        data = response.read()
        cookie = response.getheader("Set-Cookie")
        if cookie:
            self.cookie = cookie.split(";", 1)[0]
            assert "HttpOnly" in cookie and "SameSite=Strict" in cookie
        status = response.status
        content_type = response.getheader("Content-Type", "")
        connection.close()
        parsed = json.loads(data) if content_type.startswith("application/json") else data
        if isinstance(parsed, dict) and "csrf_token" in parsed:
            self.csrf = parsed["csrf_token"]
        return status, parsed

    def login(self, username):
        assert self.request("GET", "/api/me")[0] == 200
        assert self.request("POST", "/api/login", {"username": username, "password": username + "-password"})[0] == 200

    def submit(self, key, text="自己的台词", voice="female"):
        return self.request("POST", "/api/jobs", {"voice_id": voice, "text": text, "request_key": key})


def test_login_csrf_and_cookie_rotation(api):
    client = Client(api)
    assert client.request("GET", "/api/jobs")[0] == 401
    assert client.request("GET", "/api/me")[1]["authenticated"] is False
    anonymous_cookie = client.cookie
    assert client.request("POST", "/api/login", {"username": "alice", "password": "alice-password"}, csrf=False)[0] == 403
    assert client.request("POST", "/api/login", {"username": "alice", "password": "alice-password"}, origin="https://evil.invalid")[0] == 403
    assert client.request("POST", "/api/login", {"username": "alice", "password": "alice-password"})[0] == 200
    assert client.cookie != anonymous_cookie
    assert client.request("GET", "/api/me")[1]["authenticated"] is True
    assert client.request("POST", "/api/logout", {})[0] == 200
    assert client.request("GET", "/api/jobs")[0] == 401


def test_private_jobs_fifo_and_unavailable_voice(api, tmp_path):
    alice, bob = Client(api), Client(api)
    alice.login("alice")
    bob.login("bob")
    status, created = alice.submit("a", "只能爱丽丝看到")
    assert status == 201
    job_id = created["job"]["id"]
    assert alice.submit("a")[0] == 200
    status, second = bob.submit("b", "只能鲍勃看到")
    assert second["job"]["queue_position"] == 2
    listed = bob.request("GET", "/api/jobs")[1]
    assert len(listed["jobs"]) == 1
    assert "只能爱丽丝看到" not in json.dumps(listed, ensure_ascii=False)
    assert bob.request("POST", f"/api/jobs/{job_id}/cancel", {})[0] == 404
    assert bob.request("DELETE", f"/api/jobs/{job_id}")[0] == 404
    assert bob.request("GET", f"/api/jobs/{job_id}/audio")[0] == 404
    assert alice.submit("blocked", voice="unavailable")[0] == 400
    voices = alice.request("GET", "/api/voices")[1]
    assert "reference_path" not in json.dumps(voices)
    assert alice.request("GET", "/api/voices/female/reference")[1] == b"RIFF-test-original"
    api.store.claim_next()
    assert alice.request("POST", f"/api/jobs/{job_id}/cancel", {})[1]["job"]["visible_status"] == "cancel_pending"
    api.store.mark_cancelled(job_id)
    assert bob.request("GET", "/api/jobs")[1]["jobs"][0]["queue_position"] == 1
    claimed = api.store.claim_next()
    wave = tmp_path / "generated.wav"
    wave.write_bytes(b"RIFF-test-generated")
    api.store.mark_completed(claimed["id"], str(wave), 1.2)
    assert bob.request("GET", f"/api/jobs/{claimed['id']}/audio?download=1")[1] == b"RIFF-test-generated"
    assert alice.request("GET", f"/api/jobs/{claimed['id']}/audio")[0] == 404
    assert bob.request("DELETE", f"/api/jobs/{claimed['id']}")[0] == 200
    assert bob.request("GET", f"/api/jobs/{claimed['id']}/audio")[0] == 404
    assert wave.exists()  # Soft deletion never removes user media from disk.


def test_no_csrf_mutation_or_unowned_static_access(api):
    client = Client(api)
    client.login("alice")
    job_id = client.submit("a")[1]["job"]["id"]
    assert client.request("DELETE", f"/api/jobs/{job_id}", csrf=False)[0] == 403
    assert client.request("GET", "/../../station.sqlite3")[0] == 404
    assert client.request("GET", "/state/station.sqlite3")[0] == 404
