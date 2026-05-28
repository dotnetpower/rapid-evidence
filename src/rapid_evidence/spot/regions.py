"""Multi-region Azure quota probe.

Runs `az vm list-usage --location <region>` against many regions in
parallel so the dashboard can answer "how much spot capacity do I have
across the whole subscription?" — not just the single region the pool
is wired to.

This module deliberately does NOT depend on `SpotPoolManager`: it can
be invoked directly via the CLI, from a FastAPI route, or from a
24-hour background scheduler. All Azure CLI calls are guarded with a
per-region timeout so a single hung subscription cannot block the
whole probe.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Iterable, Sequence


logger = logging.getLogger(__name__)


# Azure region names: lowercase letters + digits, no shell metacharacters.
_REGION_RE = re.compile(r"^[a-z][a-z0-9]{1,40}$")
# Spot quota names: Azure SKU family identifiers.
_QUOTA_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{1,80}$")


# Curated short list of common Azure spot-VM-friendly regions.
# Production code should probably read this from
# `az account list-locations` instead of a hard-coded constant; the
# default here just keeps the CLI usable without an extra round trip.
DEFAULT_REGIONS: tuple[str, ...] = (
    "koreacentral",
    "japaneast",
    "japanwest",
    "southeastasia",
    "eastasia",
    "australiaeast",
    "centralindia",
    "eastus",
    "eastus2",
    "westus2",
    "westus3",
    "northeurope",
    "westeurope",
    "uksouth",
    "francecentral",
    "germanywestcentral",
    "swedencentral",
)


@dataclass(frozen=True)
class RegionQuotaProbe:
    region: str
    spot_quota_name: str
    used: int | None
    limit: int | None
    is_sufficient: bool | None
    headroom: int | None
    error: str | None = None
    duration_seconds: float | None = None

    @property
    def observed(self) -> bool:
        return self.error is None and self.limit is not None

    def to_dict(self) -> dict[str, object]:
        return {
            "region": self.region,
            "spot_quota_name": self.spot_quota_name,
            "used": self.used,
            "limit": self.limit,
            "is_sufficient": self.is_sufficient,
            "headroom": self.headroom,
            "error": self.error,
            "duration_seconds": self.duration_seconds,
            "observed": self.observed,
        }


@dataclass
class MultiRegionQuotaReport:
    regions: list[RegionQuotaProbe] = field(default_factory=list)
    total_limit: int = 0
    total_used: int = 0
    total_headroom: int = 0
    insufficient_regions: list[str] = field(default_factory=list)
    sufficient_regions: list[str] = field(default_factory=list)
    failed_regions: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "regions": [r.to_dict() for r in self.regions],
            "totals": {
                "limit": self.total_limit,
                "used": self.total_used,
                "headroom": self.total_headroom,
                "regions_observed": len(self.regions) - len(self.failed_regions),
                "regions_total": len(self.regions),
            },
            "insufficient_regions": list(self.insufficient_regions),
            "sufficient_regions": list(self.sufficient_regions),
            "failed_regions": list(self.failed_regions),
        }


async def probe_regions(
    *,
    regions: Sequence[str] | None = None,
    spot_quota_name: str = "standardDASv5Family",
    requested_per_region: int = 1,
    max_parallelism: int = 8,
    per_region_timeout_seconds: float = 20.0,
    az_binary: str = "az",
) -> MultiRegionQuotaReport:
    """Probe spot vCPU quota in each region concurrently.

    `max_parallelism` caps how many `az` subprocesses run at once so a
    user with 30+ regions configured does not fork 30 subprocesses and
    saturate the host. `requested_per_region` is the hypothetical
    allocation we want to test sufficiency against — defaults to 1
    (just "any headroom is enough").
    """
    selected = tuple(regions) if regions is not None else DEFAULT_REGIONS
    if not selected:
        return MultiRegionQuotaReport()
    invalid = [r for r in selected if not _REGION_RE.match(r)]
    if invalid:
        raise ValueError(f"invalid Azure region names: {invalid!r}")
    if not _QUOTA_NAME_RE.match(spot_quota_name):
        raise ValueError(f"invalid spot_quota_name: {spot_quota_name!r}")

    if shutil.which(az_binary) is None:
        # No `az` CLI on this host — return a report shaped like a
        # universal failure rather than raising, so the FastAPI route
        # can surface the diagnosis to the user.
        probes = [
            RegionQuotaProbe(
                region=r,
                spot_quota_name=spot_quota_name,
                used=None,
                limit=None,
                is_sufficient=None,
                headroom=None,
                error=f"`{az_binary}` not found on PATH",
            )
            for r in selected
        ]
        return _build_report(probes)

    semaphore = asyncio.Semaphore(max(1, max_parallelism))

    async def bound(region: str) -> RegionQuotaProbe:
        async with semaphore:
            return await _probe_one_region(
                region=region,
                spot_quota_name=spot_quota_name,
                requested=requested_per_region,
                timeout_seconds=per_region_timeout_seconds,
                az_binary=az_binary,
            )

    probes = await asyncio.gather(*(bound(r) for r in selected), return_exceptions=False)
    return _build_report(list(probes))


async def _probe_one_region(
    *,
    region: str,
    spot_quota_name: str,
    requested: int,
    timeout_seconds: float,
    az_binary: str,
) -> RegionQuotaProbe:
    loop = asyncio.get_running_loop()
    started = loop.time()
    try:
        completed = await asyncio.wait_for(
            asyncio.to_thread(
                _run_az_usage,
                az_binary=az_binary,
                region=region,
                spot_quota_name=spot_quota_name,
                timeout_seconds=timeout_seconds,
            ),
            timeout=timeout_seconds + 1.0,
        )
    except asyncio.TimeoutError:
        return RegionQuotaProbe(
            region=region,
            spot_quota_name=spot_quota_name,
            used=None,
            limit=None,
            is_sufficient=None,
            headroom=None,
            error=f"az timed out after {timeout_seconds:.0f}s",
            duration_seconds=loop.time() - started,
        )
    except subprocess.TimeoutExpired:
        return RegionQuotaProbe(
            region=region,
            spot_quota_name=spot_quota_name,
            used=None,
            limit=None,
            is_sufficient=None,
            headroom=None,
            error=f"az subprocess timed out after {timeout_seconds:.0f}s",
            duration_seconds=loop.time() - started,
        )
    except Exception as exc:  # noqa: BLE001
        return RegionQuotaProbe(
            region=region,
            spot_quota_name=spot_quota_name,
            used=None,
            limit=None,
            is_sufficient=None,
            headroom=None,
            error=str(exc),
            duration_seconds=loop.time() - started,
        )

    duration = loop.time() - started
    if completed.returncode != 0:
        return RegionQuotaProbe(
            region=region,
            spot_quota_name=spot_quota_name,
            used=None,
            limit=None,
            is_sufficient=None,
            headroom=None,
            error=(completed.stderr or completed.stdout or "az returned non-zero").strip()[
                :400
            ],
            duration_seconds=duration,
        )
    try:
        parsed = json.loads(completed.stdout) if completed.stdout.strip() else None
    except json.JSONDecodeError as exc:
        return RegionQuotaProbe(
            region=region,
            spot_quota_name=spot_quota_name,
            used=None,
            limit=None,
            is_sufficient=None,
            headroom=None,
            error=f"failed to parse az output: {exc}",
            duration_seconds=duration,
        )
    if not parsed:
        return RegionQuotaProbe(
            region=region,
            spot_quota_name=spot_quota_name,
            used=None,
            limit=None,
            is_sufficient=None,
            headroom=None,
            error=f"quota {spot_quota_name!r} not reported in {region}",
            duration_seconds=duration,
        )
    used = int(parsed.get("currentValue", 0))
    limit = int(parsed.get("limit", 0))
    headroom = max(0, limit - used)
    is_sufficient = headroom >= requested
    return RegionQuotaProbe(
        region=region,
        spot_quota_name=spot_quota_name,
        used=used,
        limit=limit,
        is_sufficient=is_sufficient,
        headroom=headroom,
        error=None,
        duration_seconds=duration,
    )


def _run_az_usage(
    *, az_binary: str, region: str, spot_quota_name: str, timeout_seconds: float
) -> subprocess.CompletedProcess[str]:
    cmd = [
        az_binary,
        "vm",
        "list-usage",
        "--location",
        region,
        "--query",
        f"[?name.value=='{spot_quota_name}'] | [0]",
        "-o",
        "json",
    ]
    # Hard subprocess timeout so a cancelled asyncio.wait_for does not
    # leave the `az` process running on its own.
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
        timeout=max(1.0, timeout_seconds),
    )


def _build_report(probes: Iterable[RegionQuotaProbe]) -> MultiRegionQuotaReport:
    report = MultiRegionQuotaReport()
    for p in probes:
        report.regions.append(p)
        if p.error is not None:
            report.failed_regions.append(p.region)
            continue
        if p.limit is not None:
            report.total_limit += p.limit
        if p.used is not None:
            report.total_used += p.used
        if p.headroom is not None:
            report.total_headroom += p.headroom
        if p.is_sufficient:
            report.sufficient_regions.append(p.region)
        else:
            report.insufficient_regions.append(p.region)
    return report


def request_quota_increase(
    region: str,
    *,
    spot_quota_name: str,
    new_limit: int,
    az_binary: str = "az",
) -> dict[str, object]:
    """Best-effort hint for raising the spot quota in a region.

    Azure quota increases require a support ticket, which `az` does not
    automate for spot vCPU. Rather than pretending we can submit one,
    this function returns a structured record describing exactly what
    the operator should run (or click) — and records the intent in the
    background job registry when called via the API route.
    """
    if not _REGION_RE.match(region):
        raise ValueError(f"invalid Azure region: {region!r}")
    if not _QUOTA_NAME_RE.match(spot_quota_name):
        raise ValueError(f"invalid spot_quota_name: {spot_quota_name!r}")
    if new_limit <= 0:
        raise ValueError("new_limit must be positive")
    return {
        "region": region,
        "spot_quota_name": spot_quota_name,
        "new_limit": new_limit,
        "status": "manual_action_required",
        "next_steps": [
            f"{az_binary} support tickets create --ticket-name 'spot-quota-{region}' "
            f"--problem-classification … --quota-ticket-details "
            f"'region={region};vmFamily={spot_quota_name};newLimit={new_limit}'",
            "Or open https://portal.azure.com → Subscriptions → Usage + quotas → "
            "Request increase.",
        ],
    }
