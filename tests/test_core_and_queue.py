from rapid_evidence.core.errors import QueueCapacityError
from rapid_evidence.core.models import FetchRequest, SourcePolicy
from rapid_evidence.queue.memory import MemoryRequestQueue


def test_policy_validation_rejects_missing_headers():
    policy = SourcePolicy(
        source="generic-http",
        min_delay_seconds=0,
        max_concurrency=2,
        max_batch_size=4,
        max_workers=2,
        required_headers={"User-Agent"},
        allowed_methods={"GET"},
        max_attempts=2,
        retry_after_seconds=5,
        max_request_bytes=1024,
    )

    request = FetchRequest(target="https://example.com", source="generic-http")

    try:
        policy.validate_request(request)
        assert False, "expected missing header validation"
    except ValueError:
        pass


def test_queue_dedupe_releases_on_dequeue():
    queue = MemoryRequestQueue(max_queued=2)
    request = FetchRequest(target="https://example.com", source="generic-http")

    assert queue.enqueue(request) is True
    assert queue.enqueue(request) is False

    batch = queue.dequeue_batch(source="generic-http", n=1)
    assert len(batch) == 1

    assert queue.enqueue(request) is True


def test_queue_capacity_limit():
    queue = MemoryRequestQueue(max_queued=1)
    request1 = FetchRequest(target="https://example.com/a", source="generic-http")
    request2 = FetchRequest(target="https://example.com/b", source="generic-http")

    assert queue.enqueue(request1) is True

    try:
        queue.enqueue(request2)
        assert False, "expected queue overflow"
    except QueueCapacityError:
        pass
