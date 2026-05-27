from typing import Protocol

from rapid_evidence.spot.models import SpotNode, SpotPoolConfig


class SpotVmProvider(Protocol):
    provider_name: str

    def create_nodes(self, count: int, config: SpotPoolConfig) -> tuple[SpotNode, ...]:
        ...

    def refresh_nodes(self) -> tuple[SpotNode, ...]:
        ...

    def terminate_nodes(self, node_ids: tuple[str, ...]) -> tuple[str, ...]:
        ...


class SpotVmDiscoveryProvider(SpotVmProvider, Protocol):
    def discover_existing_nodes(self) -> tuple[SpotNode, ...]:
        ...

    def check_quota(self, requested_nodes: int, config: SpotPoolConfig) -> tuple[dict, ...]:
        ...
