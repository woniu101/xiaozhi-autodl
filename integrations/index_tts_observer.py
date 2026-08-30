from __future__ import annotations

import asyncio
import time
from collections import deque

from fastapi import Request

from index_api.app import RUNTIME, SETTINGS, SLOTS, app


state_lock = asyncio.Lock()
inflight = 0
last_inference_duration: float | None = None
last_inference_at: float | None = None
recent_errors: deque[float] = deque()


@app.middleware("http")
async def observe_tts(request: Request, call_next):
    global inflight, last_inference_duration, last_inference_at
    is_tts = request.url.path in {"/v1/tts", "/v1/tts/stream"}
    started = time.perf_counter()
    if is_tts:
        async with state_lock:
            inflight += 1
    try:
        response = await call_next(request)
        if is_tts and response.status_code >= 500:
            recent_errors.append(time.time())
        return response
    except Exception:
        if is_tts:
            recent_errors.append(time.time())
        raise
    finally:
        if is_tts:
            async with state_lock:
                inflight = max(0, inflight - 1)
                last_inference_duration = time.perf_counter() - started
                last_inference_at = time.time()


@app.get("/internal/metrics")
async def internal_metrics():
    cutoff = time.time() - 300
    while recent_errors and recent_errors[0] < cutoff:
        recent_errors.popleft()
    active = max(0, SETTINGS.max_pending - SLOTS._value)  # noqa: SLF001
    return {
        "device": RUNTIME.status().get("device"),
        "active": active,
        "queued": max(0, inflight - active),
        "max_pending": SETTINGS.max_pending,
        "lastInferenceAgoSeconds": None if last_inference_at is None else max(0, time.time() - last_inference_at),
        "lastInferenceDuration": last_inference_duration,
        "errors5m": len(recent_errors),
    }
