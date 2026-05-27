from rapid_evidence.core.errors import PolicyViolationError
from rapid_evidence.core.models import FetchRequest, SourcePolicy


class PolicyStore:
    def __init__(self):
        self._policies: dict[str, SourcePolicy] = {}

    def register(self, policy: SourcePolicy) -> None:
        self._policies[policy.source] = policy

    def require(self, source: str) -> SourcePolicy:
        normalized = source.strip().lower()
        if normalized not in self._policies:
            raise PolicyViolationError(f"no policy registered for source: {source}")
        return self._policies[normalized]

    def validate_request(self, request: FetchRequest) -> None:
        policy = self.require(request.source)
        policy.validate_request(request)
