"""Remote worker dispatch — talks to the on-VM fetch agent.

The `RemoteWorkerSource` implements the same `fetch(url, headers)` contract
as `GenericHttpSource`, but instead of running the fetch in the host
process it reserves a Spot VM via the `SpotPoolManager`, sends the work
to that VM's agent over HTTP, and releases the node when done.
"""

from rapid_evidence.worker.transport import (
    HttpWorkerTransport,
    InMemoryWorkerTransport,
    WorkerDispatchError,
    WorkerDispatchPayload,
    WorkerDispatchResult,
    WorkerTransport,
)
from rapid_evidence.worker.source import RemoteWorkerSource

__all__ = [
    "HttpWorkerTransport",
    "InMemoryWorkerTransport",
    "RemoteWorkerSource",
    "WorkerDispatchError",
    "WorkerDispatchPayload",
    "WorkerDispatchResult",
    "WorkerTransport",
]
