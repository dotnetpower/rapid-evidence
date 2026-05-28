"""MetricsCollector: ring buffer + windowed query."""

import asyncio
import time

import pytest

from rapid_evidence.metrics import MetricsCollector
from rapid_evidence.metrics.collector import MetricSample, build_metric_sample


def _make_sample(backlog: int = 0, throughput: float = 0.0, ready: int = 0, running: int = 0, prov: int = 0):
    return build_metric_sample(
        backlog=backlog,
        throughput_per_second=throughput,
        counters={"ready": ready, "busy": running, "provisioning": prov},
        active_batches=1 if backlog else 0,
    )


def test_build_metric_sample_aggregates_counters_and_active_vms():
    sample = _make_sample(backlog=10, throughput=4.5, ready=2, running=3, prov=1)
    assert sample.backlog == 10
    assert sample.ready_vms == 2
    assert sample.running_vms == 3
    assert sample.provisioning_vms == 1
    assert sample.draining_vms == 0
    assert sample.active_vms == 6
    payload = sample.to_dict()
    assert payload["throughput_per_second"] == 4.5
    assert payload["active_vms"] == 6


@pytest.mark.asyncio
async def test_collector_starts_with_immediate_sample_and_appends_over_time():
    counter = {"v": 0}

    def snap() -> MetricSample:
        counter["v"] += 1
        return _make_sample(backlog=counter["v"])

    collector = MetricsCollector(
        snapshot=snap, sample_interval_seconds=0.05, retention_seconds=2.0
    )
    await collector.start()
    try:
        # initial sample taken on start()
        assert collector.latest().backlog == 1
        await asyncio.sleep(0.15)
        assert collector.latest().backlog >= 2
        assert len(collector.query(window_seconds=2.0)) >= 2
    finally:
        await collector.stop()


@pytest.mark.asyncio
async def test_collector_windowed_query_returns_only_recent_samples():
    def snap() -> MetricSample:
        return _make_sample(backlog=1)

    collector = MetricsCollector(snapshot=snap, sample_interval_seconds=0.02, retention_seconds=1.0)
    await collector.start()
    try:
        await asyncio.sleep(0.1)
        # request a tiny window
        recent = collector.query(window_seconds=0.04)
        all_samples = collector.query()
        assert len(recent) <= len(all_samples)
        # zero or negative window returns nothing
        assert collector.query(window_seconds=0) == []
    finally:
        await collector.stop()


@pytest.mark.asyncio
async def test_collector_bounded_ring_buffer_does_not_grow_unbounded():
    def snap() -> MetricSample:
        return _make_sample(backlog=1)

    collector = MetricsCollector(snapshot=snap, sample_interval_seconds=0.01, retention_seconds=0.1)
    await collector.start()
    try:
        await asyncio.sleep(0.3)
        all_samples = collector.query()
        # retention 0.1s / interval 0.01s = ~10 samples + headroom
        assert len(all_samples) <= 14
    finally:
        await collector.stop()


def test_collector_validates_constructor_arguments():
    with pytest.raises(ValueError):
        MetricsCollector(snapshot=lambda: _make_sample(), sample_interval_seconds=0)
    with pytest.raises(ValueError):
        MetricsCollector(snapshot=lambda: _make_sample(), sample_interval_seconds=1, retention_seconds=0)


@pytest.mark.asyncio
async def test_collector_survives_snapshot_exceptions():
    calls = {"n": 0}

    def flaky() -> MetricSample:
        calls["n"] += 1
        if calls["n"] % 2 == 0:
            raise RuntimeError("snapshot boom")
        return _make_sample(backlog=calls["n"])

    collector = MetricsCollector(snapshot=flaky, sample_interval_seconds=0.02, retention_seconds=1.0)
    await collector.start()
    try:
        await asyncio.sleep(0.15)
        # We should still have collected at least 2 successful samples despite
        # intermediate failures.
        assert len(collector.query()) >= 2
    finally:
        await collector.stop()
