import pytest

from recognition.evaluate import (
    choose_preprocessing,
    render_report,
    summarize_predictions,
)


def test_choose_preprocessing_selects_the_closest_candidate() -> None:
    assert choose_preprocessing({"foreground": 0.41, "rgb_resize": 0.55}, 0.5564) == "rgb_resize"


def test_choose_preprocessing_rejects_ambiguous_candidates() -> None:
    with pytest.raises(ValueError, match="ambiguous"):
        choose_preprocessing({"foreground": 0.551, "rgb_resize": 0.556}, 0.5564)


def test_choose_preprocessing_rejects_distant_candidates() -> None:
    with pytest.raises(ValueError, match="target"):
        choose_preprocessing({"foreground": 0.21, "rgb_resize": 0.25}, 0.5564)


def _prediction(sample_id: str, scores, encoded, text, number, origins=("reviewed", "reviewed")):
    return {
        "sample_id": sample_id,
        "status": "ok",
        "scores": scores,
        "encoded": encoded,
        "text": text,
        "number": number,
        "text_known": text is not None,
        "number_known": number is not None,
        "text_origin": origins[0],
        "number_origin": origins[1],
    }


def test_summarize_predictions_reports_known_and_encoded_metrics() -> None:
    predictions = [
        _prediction("a", [0.9, 0.1, 0.0, 0.0], [0, 1, 0, 0], 0, 1),
        _prediction("b", [0.8, 0.2, 0.0, 0.0], [1, 0, 0, 0], 1, 0),
        _prediction("c", [0.2, 0.8, 0.0, 0.0], [0, 1, 0, 0], 0, 1),
        _prediction("d", [0.1, 0.9, 0.0, 0.0], [1, 0, 0, 0], 1, 0),
    ]
    summary = summarize_predictions(
        predictions,
        checkpoint={"sha256": "abc", "numClasses": 4, "bestModelScore": 0.5564},
        prepared={"summarySha256": "def", "manifestSha256": "ghi"},
        preprocessing="rgb_resize",
        probe=None,
    )
    assert summary["coverage"]["scored"] == 4
    assert summary["channels"]["text"]["encodedAp"] == 0.5
    assert summary["channels"]["text"]["knownAp"] == 0.5
    assert summary["channels"]["number"]["encodedAp"] == 0.5
    assert "meanEncodedApTextNumber" in summary


def test_render_report_mentions_provenance_and_coverage() -> None:
    predictions = [
        _prediction("a", [0.9, 0.1, 0.0, 0.0], [1, 0, 0, 0], 1, 0),
    ]
    summary = summarize_predictions(
        predictions,
        checkpoint={"sha256": "abc", "numClasses": 4, "bestModelScore": 0.5564},
        prepared={"summarySha256": "def", "manifestSha256": "ghi"},
        preprocessing="foreground",
        probe={"foreground": 0.5564, "rgb_resize": 0.4},
    )
    report = render_report(summary)
    assert "0.5564" in report
    assert "foreground" in report
    assert "coverage" in report.lower()
