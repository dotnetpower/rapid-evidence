class RapidEvidenceError(Exception):
    pass


class PolicyViolationError(RapidEvidenceError):
    pass


class QueueCapacityError(RapidEvidenceError):
    pass


class ProviderError(RapidEvidenceError):
    pass


class SourceFetchError(RapidEvidenceError):
    pass
