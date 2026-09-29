import concurrent.futures

import pytest

from store import Store


@pytest.fixture
def queue(tmp_path):
    store = Store(tmp_path / "state")
    alice = store.create_user("alice", "strong-password-a")["id"]
    bob = store.create_user("bob", "strong-password-b")["id"]
    return store, alice, bob


def submit(store, user, key, text="测试文本"):
    return store.create_job(user, "female", text, key)


def test_fifo_idempotency_and_positions(queue):
    store, alice, bob = queue
    first = submit(store, alice, "a")
    second = submit(store, bob, "b")
    third = submit(store, alice, "c")
    assert submit(store, alice, "a")["id"] == first["id"]
    assert store.list_jobs(bob)["jobs"][0]["queue_position"] == 2
    assert len(store.list_jobs(alice)["jobs"]) == 2
    claimed = store.claim_next()
    assert claimed["id"] == first["id"]
    assert store.claim_next() is None  # Two workers cannot load models simultaneously.
    assert store.public_job(second["id"], bob)["ahead_count"] == 1
    assert store.cancel_job(second["id"], bob)
    assert store.public_job(third["id"], alice)["queue_position"] == 2
    assert store.mark_completed(first["id"], "/example/result.wav", 2.5)
    assert store.public_job(third["id"], alice)["queue_position"] == 1
    assert store.claim_next()["id"] == third["id"]


def test_ownership_cancel_delete_and_complete_race(queue):
    store, alice, bob = queue
    job = submit(store, alice, "a")
    assert store.get_job(job["id"], bob) is None
    assert not store.cancel_job(job["id"], bob)
    assert not store.delete_job(job["id"], bob)
    store.claim_next()
    assert store.cancel_job(job["id"], alice)
    visible = store.public_job(job["id"], alice)
    assert visible["status"] == "running"
    assert visible["visible_status"] == "cancel_pending"
    assert store.should_cancel(job["id"])
    assert not store.mark_completed(job["id"], "/example/result.wav", 2)
    assert store.get_job(job["id"])["status"] == "cancelled"
    second = submit(store, bob, "b")
    store.claim_next()
    store.delete_job(second["id"], bob)
    assert store.list_jobs(bob)["jobs"] == []
    assert not store.mark_completed(second["id"], "/example/result.wav", 2)
    assert store.get_job(second["id"], include_deleted=True)["status"] == "cancelled"


def test_deleted_pending_never_claimed_and_same_key_cannot_resurrect(queue):
    store, alice, bob = queue
    deleted = submit(store, alice, "a")
    live = submit(store, bob, "b")
    assert store.delete_job(deleted["id"], alice)
    with pytest.raises(ValueError, match="已删除"):
        submit(store, alice, "a")
    assert store.claim_next()["id"] == live["id"]


def test_atomic_claim_and_restart_retains_fifo(queue):
    store, alice, bob = queue
    first = submit(store, alice, "a")
    submit(store, bob, "b")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        claims = list(executor.map(lambda _: store.claim_next(), range(2)))
    assert sum(bool(item) for item in claims) == 1
    assert next(item for item in claims if item)["id"] == first["id"]
    assert store.recover_interrupted() == 1
    assert store.claim_next()["id"] == first["id"]
    store.cancel_job(first["id"], alice)
    store.recover_interrupted()
    assert store.get_job(first["id"])["status"] == "cancelled"


def test_passwords_and_sessions_are_hashed(queue):
    store, alice, _ = queue
    assert store.verify_user("alice", "wrong") is None
    assert store.verify_user("alice", "strong-password-a")["id"] == alice
    token, session = store.create_session(alice)
    assert session["user_id"] == alice
    with store.connect() as db:
        user = db.execute("SELECT * FROM users WHERE id=?", (alice,)).fetchone()
        assert user["password_hash"] != "strong-password-a"
        assert db.execute("SELECT token_hash FROM sessions").fetchone()[0] != token
    store.revoke_session(token)
    assert store.get_session(token) is None


def test_empty_and_long_inputs_rejected(queue):
    store, alice, _ = queue
    for text in ("", "  ", "字" * 301):
        with pytest.raises(ValueError):
            submit(store, alice, "a", text)


def test_release_interruption_requeues_original_id_ahead_of_new_requests(queue):
    store, alice, bob = queue
    first = submit(store, alice, "a")
    second = submit(store, bob, "b")
    store.claim_next()
    assert store.release_job(first["id"])
    restored = store.get_job(first["id"])
    assert restored["status"] == "queued"
    assert restored["started_at"] is None and restored["finished_at"] is None
    assert store.public_job(second["id"], bob)["queue_position"] == 2
    assert store.claim_next()["id"] == first["id"]
    store.cancel_job(first["id"], alice)
    assert store.release_job(first["id"])
    assert store.get_job(first["id"])["status"] == "cancelled"
    assert not store.release_job(first["id"])
    store.claim_next()
    store.delete_job(second["id"], bob)
    assert store.release_job(second["id"])
    assert store.get_job(second["id"], include_deleted=True)["status"] == "cancelled"
