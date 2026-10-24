"""
Load test (H2-8.5): simulated outreach workers listing, searching, opening profiles,
recording and saving. Run it against a backend in fake-OpenAI mode, on a local or
staging database, never production: it writes rows (and deletes them again). README
Testing, "Load test", has the commands.

    VOICEREACH_LIVE_TOKEN=<token> locust -f backend/loadtest/locustfile.py --host http://localhost:8001
"""
import json
import os
import random
import time
from pathlib import Path
from uuid import uuid4

from locust import HttpUser, between, task

SAMPLE = (Path(__file__).resolve().parent / "sample.m4a").read_bytes()   # 6 s of silence
QUERIES = ["veteran", "Mission", "diabetes", "John"]
READY_TIMEOUT_S = 90
POLL_S = 2


class OutreachWorker(HttpUser):
    wait_time = between(1, 3)

    def on_start(self):
        # Rate limits key on user + X-Device-Id, so each simulated phone gets its own bucket
        self.client.headers.update({
            "Authorization": f"Bearer {os.environ['VOICEREACH_LIVE_TOKEN']}",
            "X-Device-Id": str(uuid4()),
        })
        self.ids: list[str] = []

    @task(5)
    def list_people(self):
        with self.client.get("/api/individuals?limit=50", name="/api/individuals", catch_response=True) as r:
            if r.ok:
                self.ids = [p["id"] for p in r.json().get("individuals", [])]

    @task(3)
    def search(self):
        self.client.post("/api/embeddings/search", json={"query": random.choice(QUERIES), "top_k": 10})

    @task(2)
    def profile(self):
        if self.ids:
            self.client.get(f"/api/individuals/{random.choice(self.ids)}", name="/api/individuals/[id]")

    @task(1)
    def record(self):
        started = time.monotonic()
        location = {"latitude": 37.7599, "longitude": -122.4148, "address": "Mission St"}
        r = self.client.post("/api/recordings", name="/api/recordings", files={
            "audio": ("sample.m4a", SAMPLE, "audio/m4a")}, data={
            "client_recording_id": str(uuid4()), "duration_ms": "6000", "location": json.dumps(location)})
        if r.status_code != 202:
            return
        job_id = r.json()["id"]
        status, error = "queued", None
        while time.monotonic() - started < READY_TIMEOUT_S:
            time.sleep(POLL_S)
            poll = self.client.get(f"/api/recordings/{job_id}", name="/api/recordings/[id]")
            if not poll.ok:
                error = RuntimeError(f"poll HTTP {poll.status_code}")
                break
            status = poll.json()["status"]
            if status in ("ready", "failed"):
                break
        if status != "ready" and error is None:
            error = RuntimeError(f"recording ended {status}")
        self.environment.events.request.fire(
            request_type="JOB", name="recording ready", response_time=(time.monotonic() - started) * 1000,
            response_length=0, exception=error, context={})
        self.client.delete(f"/api/recordings/{job_id}", name="/api/recordings/[id]")

    @task(1)
    def save(self):
        name = f"Loadtest {uuid4().hex[:8]}"
        r = self.client.post("/api/individuals", name="/api/individuals [save]",
                             headers={"Idempotency-Key": str(uuid4())},
                             json={"data": {"name": name, "height": 70, "weight": 160}})
        if r.ok:
            # Leave nothing behind
            self.client.delete(f"/api/individuals/{r.json()['individual']['id']}", name="/api/individuals/[id]")
