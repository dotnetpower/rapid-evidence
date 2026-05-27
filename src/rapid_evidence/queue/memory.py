from collections import deque

from rapid_evidence.core.errors import QueueCapacityError
from rapid_evidence.core.models import FetchRequest


class MemoryRequestQueue:
    def __init__(self, max_queued: int | None = None):
        self.max_queued = max_queued
        self._deque = deque()
        self._inflight: set[str] = set()

    def enqueue(self, request: FetchRequest) -> bool:
        if self.max_queued is not None and len(self._deque) >= self.max_queued:
            raise QueueCapacityError("queue capacity exceeded")
        key = request.request_id
        if key in self._inflight:
            return False
        self._deque.append(request)
        self._inflight.add(key)
        return True

    def dequeue_batch(self, source: str, n: int) -> list[FetchRequest]:
        batch = []
        while len(batch) < n:
            if not self._deque:
                break
            request = self._deque.popleft()
            batch.append(request)
            self._inflight.discard(request.request_id)
        return batch

    def requeue_front(self, requests: list[FetchRequest]) -> None:
        for request in reversed(requests):
            self._deque.appendleft(request)
            self._inflight.add(request.request_id)

    def size(self) -> int:
        return len(self._deque)
