from rapid_evidence.core.models import SourcePolicy
from rapid_evidence.policy.policy_store import PolicyStore


def default_policy_store() -> PolicyStore:
    store = PolicyStore()
    store.register(
        SourcePolicy(
            source="generic-http",
            min_delay_seconds=0.0,
            max_concurrency=4,
            max_batch_size=8,
            max_workers=4,
            required_headers={"User-Agent"},
            allowed_methods={"GET"},
            max_attempts=3,
            retry_after_seconds=5.0,
            max_request_bytes=5_000_000,
        )
    )
    return store
