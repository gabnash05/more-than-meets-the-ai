"""CPU adapter for a safely exported Referee ViT-Tiny bundle."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from PIL import Image

BACKBONE = "vit_tiny_patch16_224.augreg_in21k_ft_in1k"
LABEL_ORDER = ("text", "number", "symbol", "circle")
CHANNEL_ORDER = ("text", "number")
PREPROCESSORS = ("foreground", "rgb_resize")


def preprocessing_hash(candidate: str) -> str:
    """Return the preprocessing fingerprint recorded in the manifest."""
    if candidate == "foreground":
        from models.guesser.data.src.common import load_step

        return load_step("06-images").candidate_hash("foreground")
    if candidate == "rgb_resize":
        encoded = json.dumps(
            {"candidate": "rgb_resize", "size": [224, 224], "normalize": False},
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return hashlib.sha256(encoded).hexdigest()
    raise ValueError(f"Unsupported preprocessing: {candidate}")


def validate_selection(selection: dict, manifest: dict) -> None:
    """Require the selection record and manifest to describe the same artifact."""
    files = manifest.get("files", {})
    if (
        selection.get("backbone") != BACKBONE
        or selection.get("preprocess_candidate") != manifest.get("preprocessing")
        or selection.get("labels_sha256") != files.get("labels.json")
        or selection.get("num_classes") != len(LABEL_ORDER)
        or selection.get("fast_dev")
        or not selection.get("best_model_path")
        or selection.get("best_model_score") is None
    ):
        raise ValueError("checkpoint-selection-mismatch")


class RefereeViT:
    """Load a Referee bundle and return two ordered evidence scores."""

    def __init__(self, root: Path, manifest: dict, labels: list[str]):
        import timm
        import torch
        from safetensors.torch import load_file

        self.torch = torch
        self.root = root
        self.manifest = manifest
        self.labels = labels
        self.candidate = manifest["preprocessing"]
        if manifest.get("version") == 2:
            from referee_data import (
                preprocess,
                preprocessing_config,
            )
            from referee_data import (
                preprocessing_hash as referee_preprocessing_hash,
            )

            if (
                manifest.get("modelId") != "referee-vit-v2"
                or manifest.get("role") != "referee"
                or manifest.get("adapter") != "vit-tiny-referee"
                or manifest.get("backbone") != BACKBONE
                or manifest.get("input") != [1, 3, 224, 224]
                or manifest.get("output") != [1, 2]
                or manifest.get("labelOrder") != list(CHANNEL_ORDER)
                or manifest.get("channelOrder") != list(CHANNEL_ORDER)
                or manifest.get("scoreActivation") != "sigmoid"
                or self.candidate != "referee-foreground-v2"
                or labels != list(CHANNEL_ORDER)
                or manifest.get("preprocessingConfig") != preprocessing_config()
                or manifest.get("preprocessingConfigHash")
                != referee_preprocessing_hash()
            ):
                raise ValueError("referee-v2-manifest-mismatch")
            files = manifest.get("files")
            required = {
                "weights.safetensors",
                "labels.txt",
                "labels.json",
                "checkpoint-selection.json",
                "evaluation-summary.json",
            }
            if not isinstance(files, dict) or set(files) != required:
                raise ValueError("referee-v2-file-list-mismatch")
            revision = hashlib.sha256(
                json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            if revision != manifest.get("artifactRevision"):
                raise ValueError("referee-v2-revision-mismatch")
            for name, digest in files.items():
                if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
                    raise ValueError("referee-v2-file-hash-mismatch")
            selection = json.loads(
                (root / "checkpoint-selection.json").read_text(encoding="utf-8")
            )
            report = json.loads(
                (root / "evaluation-summary.json").read_text(encoding="utf-8")
            )
            if (
                selection.get("evaluationReport") != "evaluation-summary.json"
                or selection.get("evaluationReportSha256")
                != files["evaluation-summary.json"]
                or report.get("checkpoint", {}).get("sha256")
                != selection.get("sourceCheckpointSha256")
                or not selection.get("sourceCheckpointSha256")
                or report.get("split") != "validation"
                or report.get("preprocessing") != "referee_foreground"
            ):
                raise ValueError("referee-v2-evaluation-mismatch")
            provenance = selection.get("provenance", {})
            if (
                provenance.get("model_id") != "referee-vit-v2"
                or provenance.get("config", {}).get("fast") is not False
                or provenance.get("preprocessing_hash") != referee_preprocessing_hash()
                or provenance.get("preprocessing_config") != preprocessing_config()
                or not provenance.get("dataset_fingerprint")
            ):
                raise ValueError("referee-v2-selection-mismatch")
            self.images = preprocess
            self.rgb = None
            self.model = timm.create_model(BACKBONE, pretrained=False, num_classes=2)
            self.model.load_state_dict(
                load_file(root / "weights.safetensors", device="cpu"), strict=True
            )
            self.model.eval()
            return
        if (
            manifest.get("version") != 1
            or manifest.get("role") != "referee"
            or manifest.get("adapter") != "vit-tiny-referee"
            or manifest.get("input") != [1, 3, 224, 224]
            or manifest.get("output") != [1, len(LABEL_ORDER)]
            or manifest.get("labelOrder") != list(LABEL_ORDER)
            or manifest.get("channelOrder") != list(CHANNEL_ORDER)
            or manifest.get("scoreActivation") != "sigmoid"
            or self.candidate not in PREPROCESSORS
        ):
            raise ValueError("referee-manifest-mismatch")
        if labels != list(LABEL_ORDER):
            raise ValueError("referee-label-order-mismatch")
        if preprocessing_hash(self.candidate) != manifest.get(
            "preprocessingConfigHash"
        ):
            raise ValueError("referee-preprocessing-mismatch")
        selection = json.loads(
            (root / "checkpoint-selection.json").read_text(encoding="utf-8")
        )
        validate_selection(selection, manifest)
        if self.candidate == "foreground":
            from models.guesser.data.src.common import load_step

            self.images = load_step("06-images")
            self.rgb = None
        else:
            from torchvision.transforms import v2

            self.images = None
            self.rgb = v2.Compose(
                [
                    v2.Resize((224, 224)),
                    v2.ToImage(),
                    v2.ToDtype(torch.float32, scale=True),
                ]
            )

        self.model = timm.create_model(
            BACKBONE, pretrained=False, num_classes=len(labels)
        )
        self.model.load_state_dict(
            load_file(root / "weights.safetensors", device="cpu"), strict=True
        )
        self.model.eval()
        with torch.inference_mode():
            self.model(torch.zeros((1, 3, 224, 224)))

    def _image_batch(self, image: Image.Image):
        if self.candidate == "referee-foreground-v2":
            sample = self.images(image)
            if sample["status"] != "ok":
                return None
            return self.torch.from_numpy(sample["image"]).unsqueeze(0)
        if self.candidate == "foreground":
            sample = self.images.preprocess(image, "foreground")
            if sample["status"] != "ok":
                return None
            return self.torch.from_numpy(sample["image"]).unsqueeze(0)
        return self.rgb(image.convert("RGB")).unsqueeze(0)

    def predict(self, image: Image.Image) -> dict:
        """Return text and number scores in the contract order."""
        batch = self._image_batch(image)
        if batch is None:
            return {"status": "unavailable", "reason": "no-evidence"}
        with self.torch.inference_mode():
            logits = self.model(batch)
        if (
            tuple(logits.shape) != (1, len(self.labels))
            or not self.torch.isfinite(logits).all()
        ):
            raise ValueError("invalid-model-output")
        probabilities = self.torch.sigmoid(logits)[0]
        return {
            "status": "evidence",
            "scores": [float(probabilities[0]), float(probabilities[1])],
        }
