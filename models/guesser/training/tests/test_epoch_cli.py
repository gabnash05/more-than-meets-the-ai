"""Exercise the real offline cache CLI on synthetic originals only."""

import json

import pytest
from training.tests.input_fixtures import prepare_drawings


def test_estimate_has_no_bundle_side_effect_and_build_requires_budget(tmp_path, capsys):
    """Estimate reports measured payloads without creating output directories."""
    from training.build_epoch_cache import main, parse_args

    prepared = prepare_drawings(tmp_path)
    target = tmp_path / "not-created" / "bundle"
    common = [
        "--prepared-dir",
        str(prepared),
        "--output",
        str(target),
        "--arms",
        "a",
        "b",
        "--epochs",
        "0",
        "1",
        "--reserve-bytes",
        "0",
    ]
    with pytest.raises(SystemExit):
        parse_args(["build", *common])
    main(["estimate", *common, "--samples", "2"])
    report = json.loads(capsys.readouterr().out)
    assert report["sampled_originals"] == 2
    assert report["estimated_encoded_bytes"] > 0
    assert report["safety_adjusted_bytes"] >= report["estimated_encoded_bytes"]
    assert not target.parent.exists()
    main(["build", *common, "--max-bytes", "10000000", "--workers", "0"])
    assert (target / "views.sqlite3").is_file()
