from rapid_evidence.spot.fake import InMemorySpotVmProvider
from rapid_evidence.spot.models import EvictionEvent, SpotCapacityPlan, SpotNode, SpotNodeState, SpotPoolConfig, SpotReservation
from rapid_evidence.spot.sizing import estimate_spot_capacity


class SpotVmScheduler:
    def __init__(self, provider, config: SpotPoolConfig, audit_sink=None, now=None):
        self.provider = provider
        self.config = config
        self.audit_sink = audit_sink
        self.now = now
        self._nodes: dict[str, SpotNode] = {}
        self._assignments: dict[str, tuple[str, ...]] = {}
        self._evicted: list[EvictionEvent] = []
        self._last_reserve = 0

    def initialize(self) -> None:
        nodes = self.provider.refresh_nodes()
        self._nodes = {node.node_id: node for node in nodes}
        self.ensure_min_ready()

    def ensure_min_ready(self) -> None:
        ready_nodes = [node for node in self._nodes.values() if node.state == SpotNodeState.READY]
        target = max(self.config.min_ready, len(ready_nodes))
        if len(self._nodes) < self.config.min_ready:
            created = self.provider.create_nodes(max(0, self.config.min_ready - len(self._nodes)), self.config)
            for node in created:
                self._nodes[node.node_id] = node
        for node in list(self._nodes.values()):
            if node.state == SpotNodeState.FAILED:
                self.provider.terminate_nodes((node.node_id,))
                self._nodes[node.node_id] = SpotNode(
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
        self._nodes = {node_id: node for node_id, node in self._nodes.items() if node.state != SpotNodeState.TERMINATED}
        target = max(self.config.min_ready, len([node for node in self._nodes.values() if node.ready]))
        if len([node for node in self._nodes.values() if node.ready]) < self.config.min_ready:
            created = self.provider.create_nodes(self.config.min_ready - len([node for node in self._nodes.values() if node.ready]), self.config)
            for node in created:
                self._nodes[node.node_id] = node

    def status(self, requested_tasks: int = 0) -> tuple[dict, SpotCapacityPlan]:
        ready_nodes = [node for node in self._nodes.values() if node.state == SpotNodeState.READY]
        immediate = min(len(ready_nodes) * self.config.per_node_concurrency, requested_tasks)
        plan = estimate_spot_capacity(self.config, requested_tasks, len(ready_nodes), len(self._nodes), {})
        snapshot = {
            "nodes": [node.__dict__ for node in self._nodes.values()],
            "capacity": plan.__dict__,
        }
        return snapshot, plan

    def reserve(self, requested_tasks: int, task_ids: list[str] | None = None) -> SpotReservation:
        if task_ids is None:
            task_ids = [f"task-{index}" for index in range(requested_tasks)]
        if len(task_ids) != requested_tasks:
            raise ValueError("task_ids length must match requested_tasks")
        assignments = {}
        node_ids = []
        ready_nodes = [node for node in self._nodes.values() if node.ready]
        for task_id, node in zip(task_ids, ready_nodes):
            node_ids.append(node.node_id)
            assignments[node.node_id] = (task_id,)
            updated = SpotNode(
                node_id=node.node_id,
                name=node.name,
                state=SpotNodeState.BUSY,
                public_ip=node.public_ip,
                outbound_ip=node.outbound_ip,
                inflight=node.inflight + 1,
                vm_size=node.vm_size,
                zone=node.zone,
                metadata=node.metadata,
                error=node.error,
            )
            self._nodes[node.node_id] = updated
            self._assignments[node.node_id] = (task_id,)
        unassigned = tuple(task_id for task_id in task_ids[len(node_ids):])
        self._last_reserve = len(task_ids)
        return SpotReservation(node_ids=tuple(node_ids), assignments=assignments, unassigned_task_ids=unassigned)

    def release(self, node_ids: tuple[str, ...]) -> None:
        for node_id in node_ids:
            node = self._nodes.get(node_id)
            if not node:
                continue
            updated = SpotNode(
                node_id=node.node_id,
                name=node.name,
                state=SpotNodeState.READY,
                public_ip=node.public_ip,
                outbound_ip=node.outbound_ip,
                inflight=max(0, node.inflight - 1),
                vm_size=node.vm_size,
                zone=node.zone,
                metadata=node.metadata,
                error=node.error,
            )
            self._nodes[node_id] = updated
            self._assignments.pop(node_id, None)

    def detect_evictions(self, previous_nodes=None) -> list[EvictionEvent]:
        events = []
        for node in list(self._nodes.values()):
            if node.state == SpotNodeState.EVICTED:
                events.append(
                    EvictionEvent(
                        node_id=node.node_id,
                        public_ip=node.public_ip,
                        reason="evicted",
                        requeue_task_ids=tuple(self._assignments.get(node.node_id, ())),
                    )
                )
        self._evicted.extend(events)
        return events

    def apply_idle_timeout(self) -> None:
        busy = [node for node in self._nodes.values() if node.state == SpotNodeState.BUSY]
        if busy:
            return
        floor = self.config.idle_floor or self.config.min_ready
        idle_nodes = [node for node in self._nodes.values() if node.state == SpotNodeState.READY]
        if len(idle_nodes) > floor:
            for node in idle_nodes[floor:]:
                self.provider.terminate_nodes((node.node_id,))
                self._nodes[node.node_id] = SpotNode(
                    node_id=node.node_id,
                    name=node.name,
                    state=SpotNodeState.TERMINATING,
                    public_ip=node.public_ip,
                    outbound_ip=node.outbound_ip,
                    inflight=node.inflight,
                    vm_size=node.vm_size,
                    zone=node.zone,
                    metadata=node.metadata,
                    error=node.error,
                )

    def cleanup_all(self) -> None:
        node_ids = tuple(node.node_id for node in self._nodes.values() if node.state != SpotNodeState.TERMINATED)
        self.provider.terminate_nodes(node_ids)
        for node_id in node_ids:
            node = self._nodes[node_id]
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

    def evicted_events(self) -> list[EvictionEvent]:
        return list(self._evicted)

    def drain_evicted_events(self) -> list[EvictionEvent]:
        events = list(self._evicted)
        self._evicted.clear()
        return events
