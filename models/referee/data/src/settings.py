"""Editable defaults for the Referee's CPU data workflow."""

from dataclasses import dataclass
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = PACKAGE_ROOT / ".local" / "data"
SEED = 198173
SPLITS = ("train", "validation", "test")
PROFILES = ("sample", "train")
LABEL_ORDER = ("text", "number")
POLICY_VERSION = "separate-writing-advisories-v1"
SCHEMA_VERSION = 1

RECORD_ID = "7330402"
SOURCE_API = f"https://zenodo.org/api/records/{RECORD_ID}"
ARCHIVE_NAME = "DrawMon-ACMMM22_Dataset.zip"
ARCHIVE_SIZE = 397_584_204
ARCHIVE_MD5 = "c199d21b6121819c81cfcda68cd440bd"
TRAIN_ARCHIVE = "multiclass/train.zip"
TEST_ARCHIVE = "multiclass/test.zip"
SAMPLE_PER_FOLDER = 2
SAMPLE_BYTE_CAP = 24 * 1024 * 1024
DISCLOSED_TEST_PATHS = frozenset(
    f"val/sample_{index}.png" for index in (4036, 2326, 879)
)


@dataclass(frozen=True)
class Settings:
    data_root: Path = DEFAULT_DATA_ROOT
    profile: str = "sample"
    seed: int = SEED

    def __post_init__(self) -> None:
        if self.profile not in PROFILES:
            raise ValueError(f"Unknown Referee data profile: {self.profile}")
        object.__setattr__(
            self, "data_root", Path(self.data_root).expanduser().resolve()
        )

    @property
    def base(self) -> Path:
        return self.data_root / self.profile

    @property
    def source(self) -> Path:
        return self.base / "source"

    @property
    def prepared(self) -> Path:
        return self.base / "prepared"

    @property
    def previews(self) -> Path:
        return self.base / "preview"

    @property
    def exports(self) -> Path:
        return self.base / "exports"
