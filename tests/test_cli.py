import json

import pytest

from rapid_evidence.cli import main
from rapid_evidence.spot.models import QuotaSnapshot


def test_cli_run_local_requires_url():
    with pytest.raises(SystemExit):
        main(["run-local"])


def test_cli_spot_quota_reports_region_snapshot(monkeypatch, capsys):
    class FakeProvider:
        def __init__(self, config):
            self.config = config

        def check_quota(self, requested_nodes, config):
            return QuotaSnapshot(used=2, limit=10, spot_quota_observed=True, public_ip_quota_observed=False, is_sufficient=True)

    import rapid_evidence.spot.azure_cli_provider as azure_module

    monkeypatch.setattr(azure_module, "AzureCliSpotVmProvider", FakeProvider)

    assert main(["spot-quota", "--region", "eastus2", "--requested-nodes", "2"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["region"] == "eastus2"
    assert output["requested_nodes"] == 2
    assert output["used"] == 2
    assert output["limit"] == 10
    assert output["remaining"] == 8
    assert output["sufficient"] is True
    assert output["spot_quota_observed"] is True
