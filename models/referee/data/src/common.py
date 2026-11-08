"""File helpers and the numbered stage importer."""

import hashlib
import json
import os
import tempfile
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from importlib import import_module
from pathlib import Path
from types import ModuleType
from typing import Any, BinaryIO


class DataError(RuntimeError):
    """An actionable data-pipeline failure."""

    def __init__(self, message: str, code: str = "data_error") -> None:
        super().__init__(message)
        self.code = code


def load_step(name: str) -> ModuleType:
    return import_module("." + name, package=__package__)


def file_hash(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def preparation_input_hashes(base: Path) -> dict[str, str | None]:
    """Fingerprint the pair index and review inputs."""
    names = ("source/pairs.jsonl", "corrections.jsonl", "duplicate-groups.jsonl")
    return {
        name: file_hash(base / name) if (base / name).is_file() else None
        for name in names
    }


def json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def object_hash(value: object) -> str:
    return hashlib.sha256(json_bytes(value)).hexdigest()


@contextmanager
def atomic_output(path: Path) -> Iterator[BinaryIO]:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(dir=path.parent, suffix=".part")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            yield output
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json(path: Path, value: object) -> None:
    with atomic_output(path) as output:
        document = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
        output.write((document + "\n").encode("utf-8"))


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def iter_jsonl(path: Path) -> Iterator[Any]:
    with path.open(encoding="utf-8") as source:
        for number, line in enumerate(source, 1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except ValueError as exc:
                raise DataError(
                    f"Invalid JSON at {path}:{number}", "invalid_jsonl"
                ) from exc


def write_jsonl(path: Path, values: Iterable[object]) -> str:
    digest = hashlib.sha256()
    with atomic_output(path) as output:
        for value in values:
            line = json_bytes(value) + b"\n"
            digest.update(line)
            output.write(line)
    return digest.hexdigest()


def resolve_relative(root: Path, relative: str) -> Path:
    """Resolve a POSIX-style relative data path inside its intended directory."""
    parts = relative.split("/")
    if any(part in ("", ".", "..") for part in parts) or any(
        char in relative for char in ("\\", ":", "\0")
    ):
        raise DataError(f"Unsafe relative path: {relative!r}", "invalid_path")
    root = root.resolve()
    path = root.joinpath(*parts).resolve()
    if not path.is_relative_to(root):
        raise DataError(f"Path leaves data root: {relative!r}", "invalid_path")
    return path
