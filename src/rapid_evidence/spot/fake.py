from rapid_evidence.spot.models import SpotNode, SpotNodeState, SpotPoolConfig


class InMemorySpotVmProvider:
    provider_name = "in-memory"

    def __init__(self):
        self._nodes: dict[str, SpotNode] = {}

    def create_nodes(self, count: int, config: SpotPoolConfig) -> tuple[SpotNode, ...]:
        created = []
        for index in range(count):
            node_id = f"node-{len(self._nodes)+1}"
            node = SpotNode(
                node_id=node_id,
                name=f"vm-{node_id}",
                state=SpotNodeState.READY,
                public_ip=f"10.0.0.{len(self._nodes)+1}",
                outbound_ip=f"10.0.0.{len(self._nodes)+1}",
                inflight=0,
                vm_size="Standard_D2as_v5",
            )
            self._nodes[node_id] = node
            created.append(node)
        return tuple(created)

    def refresh_nodes(self) -> tuple[SpotNode, ...]:
        return tuple(self._nodes.values())

    def terminate_nodes(self, node_ids: tuple[str, ...]) -> tuple[str, ...]:
        terminated = []
        for node_id in node_ids:
            node = self._nodes.get(node_id)
            if node is None:
                continue
            self._nodes[node_id] = SpotNode(
                node_id=node.node_id,
                name=node.name,
                state=SpotNodeState.TERMINATED,
                public_ip=node.public_ip,
                outbound_ip=node.outbound_ip,
                inflight=node.inflight,
                vm_size=node.vm_size,
                zone=node.zone,
                metadata=node.metadata,
                error=node.error,
            )
            terminated.append(node_id)
        return tuple(terminated)

    def simulate_state(self, node_id: str, state: SpotNodeState, *, error: str | None = None) -> None:
        node = self._nodes.get(node_id)
        if node is None:
            raise KeyError(node_id)
        self._nodes[node_id] = SpotNode(
            node_id=node.node_id,
            name=node.name,
            state=state,
            public_ip=node.public_ip,
            outbound_ip=node.outbound_ip,
            inflight=node.inflight,
            vm_size=node.vm_size,
            zone=node.zone,
            metadata=node.metadata,
            error=error or node.error,
        )

    @property
    def nodes(self) -> dict[str, SpotNode]:
        return self._nodes
