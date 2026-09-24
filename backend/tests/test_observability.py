"""The internal observer's live telemetry stays bounded and excludes request data."""

from app.services.observability import RequestTelemetry


def test_request_telemetry_reports_latency_throughput_and_route_summaries():
    telemetry = RequestTelemetry(max_samples=4)
    telemetry.record("GET", "/api/v1/profile", 200, 12.5)
    telemetry.record("POST", "/api/v1/reformat", 503, 240.0)
    telemetry.record("GET", "/api/v1/profile", 200, 18.0)

    snapshot = telemetry.snapshot()

    assert snapshot["traffic"]["requests_1m"] == 3
    assert snapshot["traffic"]["status_counts_5m"] == {"2xx": 2, "3xx": 0, "4xx": 0, "5xx": 1}
    assert snapshot["latency"]["p95_ms_5m"] == 240.0
    assert snapshot["endpoints"][0]["path"] == "/api/v1/profile"
    assert snapshot["recent_requests"][0]["path"] == "/api/v1/profile"
    assert len(snapshot["timeline"]) == 10
    assert set(snapshot["timeline"][-1]) == {"at", "requests", "avg_ms", "p95_ms", "server_errors"}
    assert "query" not in snapshot["recent_requests"][0]
    assert "body" not in snapshot["recent_requests"][0]
