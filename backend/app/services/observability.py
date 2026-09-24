"""Bounded, privacy-safe request telemetry for the internal observer panel."""

from collections import Counter, deque
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from time import perf_counter


@dataclass(frozen=True)
class RequestSample:
    timestamp: datetime
    method: str
    path: str
    status_code: int
    duration_ms: float


class RequestTelemetry:
    """A fixed-size rolling request buffer owned by one backend process.

    This deliberately does not retain IP addresses, headers, query strings,
    bodies, user identifiers, or generated content. It is a quick operational
    lens, not a replacement for centralised logs/metrics in a multi-replica
    production deployment.
    """

    def __init__(self, max_samples: int = 2_000):
        self._started_at = datetime.now(timezone.utc)
        self._samples: deque[RequestSample] = deque(maxlen=max_samples)
        self._lock = Lock()

    def record(self, method: str, path: str, status_code: int, duration_ms: float) -> None:
        with self._lock:
            self._samples.append(
                RequestSample(
                    timestamp=datetime.now(timezone.utc),
                    method=method,
                    path=path,
                    status_code=status_code,
                    duration_ms=round(duration_ms, 2),
                )
            )

    @staticmethod
    def _percentile(values: list[float], percentile: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        index = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * percentile)))
        return round(ordered[index], 2)

    def snapshot(self) -> dict:
        now = datetime.now(timezone.utc)
        one_minute_ago = now.timestamp() - 60
        five_minutes_ago = now.timestamp() - 300
        bucket_seconds = 30

        with self._lock:
            samples = list(self._samples)

        minute = [sample for sample in samples if sample.timestamp.timestamp() >= one_minute_ago]
        five_minutes = [sample for sample in samples if sample.timestamp.timestamp() >= five_minutes_ago]
        durations = [sample.duration_ms for sample in five_minutes]
        statuses = Counter(f"{sample.status_code // 100}xx" for sample in five_minutes)

        endpoint_samples: dict[tuple[str, str], list[RequestSample]] = {}
        for sample in five_minutes:
            endpoint_samples.setdefault((sample.method, sample.path), []).append(sample)

        endpoints = []
        for (method, path), entries in endpoint_samples.items():
            entry_durations = [entry.duration_ms for entry in entries]
            failures = sum(1 for entry in entries if entry.status_code >= 500)
            endpoints.append(
                {
                    "method": method,
                    "path": path,
                    "requests": len(entries),
                    "avg_ms": round(sum(entry_durations) / len(entry_durations), 2),
                    "p95_ms": self._percentile(entry_durations, 0.95),
                    "server_errors": failures,
                }
            )
        endpoints.sort(key=lambda entry: (-entry["requests"], -entry["p95_ms"], entry["path"]))

        recent = [
            {
                "at": sample.timestamp.isoformat(),
                "method": sample.method,
                "path": sample.path,
                "status": sample.status_code,
                "duration_ms": sample.duration_ms,
            }
            for sample in reversed(samples[-50:])
        ]

        # Ten short buckets make a trend legible without pretending this is a
        # long-term metrics store. They are aligned to the clock so each
        # refresh replaces only the newest bucket instead of redrawing all
        # points with an arbitrary moving origin.
        latest_bucket = int(now.timestamp() // bucket_seconds) * bucket_seconds
        timeline = []
        for index in range(10):
            start = latest_bucket - ((9 - index) * bucket_seconds)
            end = start + bucket_seconds
            bucket = [sample for sample in samples if start <= sample.timestamp.timestamp() < end]
            bucket_durations = [sample.duration_ms for sample in bucket]
            timeline.append(
                {
                    "at": datetime.fromtimestamp(start, tz=timezone.utc).isoformat(),
                    "requests": len(bucket),
                    "avg_ms": round(sum(bucket_durations) / len(bucket_durations), 2) if bucket_durations else 0.0,
                    "p95_ms": self._percentile(bucket_durations, 0.95),
                    "server_errors": sum(1 for sample in bucket if sample.status_code >= 500),
                }
            )

        return {
            "scope": "this backend process",
            "process_started_at": self._started_at.isoformat(),
            "uptime_seconds": int((now - self._started_at).total_seconds()),
            "traffic": {
                "requests_1m": len(minute),
                "requests_5m": len(five_minutes),
                "requests_per_second_1m": round(len(minute) / 60, 3),
                "requests_per_minute_1m": round(float(len(minute)), 1),
                "status_counts_5m": {
                    "2xx": statuses["2xx"],
                    "3xx": statuses["3xx"],
                    "4xx": statuses["4xx"],
                    "5xx": statuses["5xx"],
                },
            },
            "latency": {
                "avg_ms_5m": round(sum(durations) / len(durations), 2) if durations else 0.0,
                "p50_ms_5m": self._percentile(durations, 0.50),
                "p95_ms_5m": self._percentile(durations, 0.95),
                "max_ms_5m": round(max(durations), 2) if durations else 0.0,
            },
            "endpoints": endpoints[:12],
            "recent_requests": recent,
            "timeline": timeline,
        }


telemetry = RequestTelemetry()


async def measure_request(request, call_next):
    """Middleware body kept separate so the app module remains readable."""
    if request.url.path.startswith("/api/v1/observer"):
        return await call_next(request)

    started = perf_counter()
    status_code = 500
    try:
        response = await call_next(request)
        status_code = response.status_code
        return response
    finally:
        telemetry.record(
            request.method,
            request.url.path,
            status_code,
            (perf_counter() - started) * 1_000,
        )
