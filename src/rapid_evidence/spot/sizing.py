from rapid_evidence.spot.models import SpotCapacityPlan, SpotPoolConfig


def estimate_spot_capacity(config: SpotPoolConfig, requested_tasks: int, ready_nodes: int, active_nodes: int, timings: dict) -> SpotCapacityPlan:
    immediate = min(ready_nodes * config.per_node_concurrency, requested_tasks)
    queued = max(0, requested_tasks - immediate)
    overflow = max(0, queued - max(0, config.max_nodes - ready_nodes))
    target_nodes = max(config.min_ready, min(config.max_nodes, (requested_tasks + config.per_node_concurrency - 1) // config.per_node_concurrency))
    scale_up = max(0, target_nodes - ready_nodes)
    scale_down = max(0, ready_nodes - max(config.min_ready, target_nodes))
    return SpotCapacityPlan(
        immediate_tasks=immediate,
        queued_tasks=queued,
        overflow_tasks=overflow,
        target_nodes=target_nodes,
        scale_up_nodes=scale_up,
        scale_down_nodes=scale_down,
        estimated_new_ready_seconds=timings.get("estimated_new_ready_seconds", 0.0),
    )
