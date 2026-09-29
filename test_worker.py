"""Queue failure semantics that must never strand the whole FIFO."""
import io
import json
from pathlib import Path
import sys
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).parent))
from worker import CloudQueue, LocalQueue
from store import Store
from voxcpm_runner import split_text


def test_split_keeps_all_characters():
    for text in ['。甲\n乙！？丙', '甲' * 300, '测试，' * 80 + '结尾。', '\n甲，乙\n\n丙。']:
        pieces = split_text(text)
        assert ''.join(pieces) == text
        assert max(map(len, pieces)) <= 60


def test_quota_error_finishes_failed(tmp_path):
    config = {'cloud_url': 'https://example.invalid', 'worker_token': 'unit-test-only',
              'worker_id': 'test', 'output_root': str(tmp_path)}
    client = CloudQueue(config)
    audio = tmp_path / 'test.wav'
    audio.write_bytes(b'RIFF' + bytes(100))
    client.check = lambda job, progress=None: False
    calls = []
    def request(path, data=None, method='POST', binary=False):
        calls.append((path, data))
        if '/audio?' in path:
            raise HTTPError('https://example.invalid', 507, 'quota', {}, io.BytesIO(b'{}'))
        return {'ok': True}
    client.request = request
    client.finish({'id': 1, 'lease_token': 'test-lease'},
                  {'status': 'completed', 'path': str(audio), 'duration_seconds': 1})
    assert calls[-1][0].endswith('/finish')
    assert calls[-1][1]['status'] == 'failed'
    assert '存储已满' in calls[-1][1]['error']


def test_unavailable_catalog_does_not_block_next_job(tmp_path):
    voices = tmp_path / 'voices.json'
    voices.write_text(json.dumps({'voices': []}))
    client = LocalQueue({'state_dir': str(tmp_path / 'state'), 'voices_path': str(voices)})
    user = client.store.create_user('test', 'test-password')
    job = client.store.create_job(user['id'], 'removed-voice', '测试', 'one')
    assert client.next() is None
    assert client.store.get_job(job['id'])['status'] == 'failed'
    assert client.store.list_jobs(user['id'])['queue']['active_count'] == 0


def test_reference_download_failure_releases_lease(tmp_path):
    client = CloudQueue({'cloud_url': 'https://example.invalid', 'worker_token': 'test',
                         'worker_id': 'test', 'output_root': str(tmp_path)})
    calls = []
    def request(path, data=None, method='POST', binary=False):
        calls.append(path)
        if path.endswith('/claim'):
            return {'job': {'id': 7, 'lease_token': 'test', 'reference_url': '/reference'}}
        if path == '/reference':
            raise OSError('temporary network failure')
        return {'ok': True}
    client.request = request
    import pytest
    with pytest.raises(OSError):
        client.next()
    assert calls[-1] == '/api/worker/jobs/7/release'


def test_upload_success_finish_network_failure_reuses_audio(tmp_path):
    client = CloudQueue({'cloud_url': 'https://example.invalid', 'worker_token': 'test',
                         'worker_id': 'test', 'output_root': str(tmp_path)})
    audio = tmp_path / 'audio.wav'
    audio.write_bytes(b'RIFF')
    calls = []
    client.check = lambda job, progress=None: False
    def request(path, data=None, method='POST', binary=False):
        calls.append(path)
        if '/audio?' in path:
            return json.dumps({'audio_key': 'jobs/1/test.wav'}).encode()
        if len([p for p in calls if p.endswith('/finish')]) == 1:
            raise OSError('response lost')
        return {'ok': True}
    client.request = request
    result = {'status': 'completed', 'path': str(audio), 'duration_seconds': 1}
    job = {'id': 1, 'lease_token': 'test'}
    import pytest
    with pytest.raises(OSError):
        client.finish(job, result)
    client.finish(job, result)
    assert sum('/audio?' in path for path in calls) == 1


def test_expired_lease_is_not_renewed(tmp_path):
    from worker import LeaseLost
    import pytest
    client = CloudQueue({'cloud_url': 'https://example.invalid', 'worker_token': 'test',
                         'worker_id': 'test', 'output_root': str(tmp_path)})
    client.request = lambda *a, **kw: pytest.fail('expired ownership must not be renewed')
    with pytest.raises(LeaseLost):
        client.check({'id': 1, 'lease_token': 'old', '_lease_deadline': 0})


def test_heartbeat_progress_and_lease_are_updated(tmp_path):
    import time
    client = CloudQueue({'cloud_url': 'https://example.invalid', 'worker_token': 'test',
                         'worker_id': 'test', 'output_root': str(tmp_path)})
    bodies = []
    def request(path, data):
        bodies.append(data)
        return {'cancel_requested': False, 'lease_expires_at': time.time() + 300}
    client.request = request
    job = {'id': 1, 'lease_token': 'test'}
    assert not client.check(job, {'phase': 'generating', 'completed_segments': 2, 'total_segments': 5, 'elapsed_seconds': 30})
    assert bodies[0]['completed_segments'] == 2
    assert 285 < job['_lease_deadline'] - time.monotonic() < 295


def test_watchdog_stops_old_process_retries_once_and_moves_on(tmp_path, monkeypatch):
    import worker
    import subprocess
    import pytest
    config = tmp_path / 'config.json'
    config.write_text(json.dumps({'output_root': str(tmp_path / 'output'), 'sentence_timeout_seconds': .01}))
    processes = []
    real_popen = subprocess.Popen
    def spawn(*args, **kwargs):
        assert all(process.poll() is not None for process in processes)
        # A real live child that never completes a sentence.
        process = real_popen([sys.executable, '-u', '-c',
            'import time; print(\'VOICE_EVENT {"type":"ready"}\',flush=True); time.sleep(30)'], **kwargs)
        processes.append(process)
        return process
    results = []
    class Backend:
        def __init__(self, config): pass
        def recover(self): pass
        def heartbeat(self, *args): pass
        def check(self, *args): return False
        def next(self):
            if results: raise KeyboardInterrupt()
            return {'id': 1}
        def finish(self, job, result): results.append(result)
        def release(self, job): pass
    monkeypatch.setattr(worker, 'LocalQueue', Backend)
    monkeypatch.setattr(worker.subprocess, 'Popen', spawn)
    monkeypatch.setattr(worker.sys, 'argv', ['worker.py', '--config', str(config)])
    monkeypatch.setattr(worker.signal, 'signal', lambda *args: None)
    with pytest.raises(KeyboardInterrupt):
        worker.main()
    assert results[0]['status'] == 'failed'
    assert '重试一次' in results[0]['error']
    assert len(processes) == 3  # Initial, one retry, clean runner for the next FIFO job.
    assert all(process.poll() is not None for process in processes)
    assert json.loads((tmp_path / 'output/job-1-watchdog.json').read_text())['retries'] == 1


def test_model_load_timeout_terminates_child(tmp_path, monkeypatch):
    import worker
    import subprocess
    import pytest
    config = tmp_path / 'config.json'
    config.write_text(json.dumps({'output_root': str(tmp_path / 'output'), 'model_load_timeout_seconds': .02}))
    processes = []
    real_popen = subprocess.Popen
    def spawn(*args, **kwargs):
        process = real_popen([sys.executable, '-u', '-c', 'import time; time.sleep(30)'], **kwargs)
        processes.append(process)
        return process
    class Backend:
        def __init__(self, config): pass
        def recover(self): pass
        def heartbeat(self, *args): pass
    monkeypatch.setattr(worker, 'LocalQueue', Backend)
    monkeypatch.setattr(worker.subprocess, 'Popen', spawn)
    monkeypatch.setattr(worker.sys, 'argv', ['worker.py', '--config', str(config)])
    monkeypatch.setattr(worker.signal, 'signal', lambda *args: None)
    with pytest.raises(TimeoutError, match='模型加载超时'):
        worker.main()
    assert processes[0].poll() is not None


def test_transient_heartbeat_failure_preserves_valid_lease(tmp_path):
    import time
    import pytest
    client = CloudQueue({'cloud_url': 'https://example.invalid', 'worker_token': 'test',
                         'worker_id': 'test', 'output_root': str(tmp_path)})
    deadline = time.monotonic() + 200
    job = {'id': 1, 'lease_token': 'test', '_lease_deadline': deadline}
    def unavailable(*args, **kwargs):
        raise OSError('temporary disconnect')
    client.request = unavailable
    with pytest.raises(OSError):
        client.check(job)
    assert job['_lease_deadline'] == deadline
    assert not job.get('_lease_lost')


def test_finish_flushes_final_segment_progress_before_upload(tmp_path):
    client = CloudQueue({'cloud_url': 'https://example.invalid', 'worker_token': 'test',
                         'worker_id': 'test', 'output_root': str(tmp_path)})
    audio = tmp_path / 'speech.wav'
    audio.write_bytes(b'RIFF')
    calls = []
    def request(path, data=None, method='POST', binary=False):
        calls.append((path, data))
        if '/audio?' in path:
            return json.dumps({'audio_key': 'jobs/1/test.wav'}).encode()
        return {'cancel_requested': False}
    client.request = request
    progress = {'phase': 'uploading', 'completed_segments': 2, 'total_segments': 2, 'elapsed_seconds': 44}
    client.finish({'id': 1, 'lease_token': 'test'}, {'status': 'completed', 'path': str(audio),
                  'duration_seconds': 4.4, 'progress': progress})
    assert calls[0][0].endswith('/heartbeat')
    assert calls[0][1] == {'lease_token': 'test', **progress}
    assert '/audio?' in calls[1][0]
    assert calls[-1][0].endswith('/finish')
