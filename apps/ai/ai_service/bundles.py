"""Validate the selected bundle independently for each role."""

from dataclasses import dataclass, field
from hashlib import file_digest
import json
import os
from pathlib import Path
import re
from typing import Protocol

from PIL import Image

from models.guesser.inference.quickdraw import HASHES, REVISION, QuickDraw
from models.referee.inference.fixture import RefereeFixture

MODEL_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}")


class Adapter(Protocol):
    def predict(self, image: Image.Image) -> dict: ...


@dataclass
class Bundle:
    model_id: str
    revision: str | None = None
    labels: list[str] = field(default_factory=list)
    adapter: Adapter | None = None
    reason: str | None = None

    def readiness(self) -> dict:
        result = {
            "status": "ready" if self.adapter else ("unavailable" if self.model_id else "disabled"),
            "modelId": self.model_id or None,
            "artifactRevision": self.revision,
        }
        if self.reason:
            result["reason"] = self.reason
        if self.labels:
            result["labels"] = self.labels
        return result


def load_bundle(role: str, model_id: str, artifact_root: Path) -> Bundle:
    if not model_id:
        return Bundle(model_id)
    if not MODEL_ID.fullmatch(model_id):
        return Bundle(model_id, reason="invalid-model-id")
    if role == "referee":
        if model_id == "referee-fixture-v1" and os.getenv("AI_TEST_FIXTURES") == "1":
            return Bundle(model_id, "fixture-v1", adapter=RefereeFixture())
        return Bundle(model_id, reason="referee-adapter-unavailable")
    try:
        root = artifact_root / model_id
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        revision = manifest["artifactRevision"]
        if (
            manifest["version"] != 1
            or manifest["role"] != role
            or manifest["modelId"] != model_id
            or not isinstance(revision, str)
            or not 1 <= len(revision) <= 128
            or manifest["output"] != [1, 345]
        ):
            return Bundle(model_id, reason="manifest-contract-mismatch")
        files = manifest["files"]
        if model_id == "quickdraw-int8-smoke":
            if os.getenv("AI_SMOKE_TEST") != "1":
                return Bundle(model_id, reason="smoke-test-disabled")
            if (
                revision != REVISION
                or manifest["adapter"] != "quickdraw-int8"
                or manifest["preprocessing"] != "quickdraw-white-strokes-v1"
                or manifest["input"] != [1, 28, 28, 1]
                or files != HASHES
            ):
                return Bundle(model_id, reason="smoke-contract-mismatch")
        elif (
            manifest["adapter"] != "vit-tiny"
            or manifest["preprocessing"] not in ("foreground", "edges")
            or manifest["input"] != [1, 3, 224, 224]
            or set(files) != {"weights.safetensors", "labels.txt", "labels.json", "checkpoint-selection.json"}
        ):
            return Bundle(model_id, reason="vit-contract-mismatch")
        for name, expected in files.items():
            with (root / name).open("rb") as file:
                actual = file_digest(file, "sha256").hexdigest()
            if actual != expected:
                return Bundle(model_id, reason="artifact-hash-mismatch")
        labels = (root / "labels.txt").read_text(encoding="utf-8").splitlines()
        if len(labels) != 345 or len({label.casefold() for label in labels}) != 345 or any(not label.strip() for label in labels):
            return Bundle(model_id, reason="invalid-label-order")
        if model_id != "quickdraw-int8-smoke":
            try:
                labels_json = json.loads(
                    (root / "labels.json").read_text(encoding="utf-8")
                )
            except ValueError:
                return Bundle(model_id, reason="invalid-label-order")
            if (
                not isinstance(labels_json, list)
                or len(labels_json) != 345
                or not all(isinstance(entry, dict) for entry in labels_json)
                or [entry.get("class_id") for entry in labels_json] != list(range(345))
                or [entry.get("source_name") for entry in labels_json] != labels
            ):
                return Bundle(model_id, reason="invalid-label-order")
        if model_id == "quickdraw-int8-smoke":
            adapter = QuickDraw(root / "model.tflite", labels)
        else:
            from models.guesser.inference.vit import ViTTiny

            adapter = ViTTiny(root, manifest, labels)
        return Bundle(model_id, revision, labels, adapter)
    except FileNotFoundError:
        return Bundle(model_id, reason="bundle-file-missing")
    except ImportError:
        return Bundle(model_id, reason="adapter-dependencies-missing")
    except (KeyError, TypeError, ValueError, OSError, RuntimeError):
        return Bundle(model_id, reason="incompatible-bundle")
