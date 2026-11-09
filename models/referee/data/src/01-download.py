"""Acquire verified ATYPICT members using bounded HTTP ranges or local fixtures."""

import hashlib
import random
import ssl
import time
import io
import json
import os
import re
import shutil
import stat
import struct
import urllib.request
import urllib.error
import zipfile
from collections.abc import Callable, Iterator, Mapping
from contextlib import ExitStack, contextmanager
from http.client import HTTPResponse, IncompleteRead
from pathlib import Path


from .common import (
    DataError,
    atomic_json,
    atomic_output,
    file_hash,
    read_json,
    relative_parts,
    resolve_relative,
    write_jsonl,
)
from .settings import (
    ARCHIVE_MD5,
    ARCHIVE_NAME,
    ARCHIVE_SIZE,
    RECORD_ID,
    SAMPLE_BYTE_CAP,
    SAMPLE_PER_FOLDER,
    SOURCE_API,
    TEST_ARCHIVE,
    TRAIN_ARCHIVE,
    Settings,
)


def _safe(info: zipfile.ZipInfo) -> None:
    name = info.filename.rstrip("/")
    relative_parts(name)
    mode = info.external_attr >> 16
    if mode and stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise DataError(f"Unsupported ZIP member type: {name}")
    if info.flag_bits & 1 or info.file_size > 200_000_000:
        raise DataError(f"Unsupported ZIP member: {name}")


def _pairs(archive: zipfile.ZipFile, source_archive: str) -> tuple[list[dict], int]:
    partition = "train" if source_archive == TRAIN_ARCHIVE else "test"
    root = "train" if partition == "train" else "val"
    names = set()
    for info in archive.infolist():
        _safe(info)
        if info.filename in names:
            raise DataError(f"Duplicate ZIP member: {info.filename}")
        names.add(info.filename)
        if info.filename.rstrip("/").split("/")[0] != root:
            raise DataError(f"Unexpected archive root: {info.filename}")
    rows = []
    missing = 0
    pattern = re.compile(r"^(.+)/sample_(\d+)\.png$")
    for name in sorted(names):
        match = pattern.fullmatch(name)
        if not match:
            continue
        parent, number = match.groups()
        folder = parent.removeprefix("train/") if partition == "train" else parent
        sample = f"{parent}/sample_{number}.npy"
        label = f"{parent}/label_{number}.npy"
        if sample not in names or label not in names:
            missing += 1
            continue
        rows.append(
            dict(
                sample_id=f"zenodo{RECORD_ID}:multiclass:{partition}:{folder}:{number}",
                variant="multiclass",
                source_archive=source_archive,
                source_partition=partition,
                provenance_folder=folder,
                png_member=name,
                sample_npy_member=sample,
                label_npy_member=label,
            )
        )
    return rows, missing


def _receipt(settings: Settings, kind: str, rows: list[dict], **extra: object) -> dict:
    receipt = dict(
        schema_version=1,
        profile=settings.profile,
        source_kind=kind,
        record_id=RECORD_ID,
        archive_name=ARCHIVE_NAME,
        archive_size=ARCHIVE_SIZE,
        archive_md5=ARCHIVE_MD5,
        full_source_verified=False,
        complete=kind == "atypict_range_multiclass"
        and not extra.get("in_progress", False),
        pair_count=len(rows),
        **extra,
    )
    write_jsonl(settings.source / "pairs.jsonl", rows)
    atomic_json(settings.source / "source-receipt.json", receipt)
    return receipt


def stage_fixture(settings: Settings, archives: Mapping[str, Path]) -> dict:
    """Validate and stage the two synthetic archives without network access."""
    if set(archives) != {TRAIN_ARCHIVE, TEST_ARCHIVE}:
        raise DataError("Fixture must provide both multiclass archives")
    rows: list[dict] = []
    missing = 0
    hashes = {}
    for name in (TRAIN_ARCHIVE, TEST_ARCHIVE):
        path = Path(archives[name])
        try:
            with zipfile.ZipFile(path) as archive:
                found, absent = _pairs(archive, name)
                for row in found:
                    for key in ("png_member", "sample_npy_member", "label_npy_member"):
                        archive.read(row[key])
                rows.extend(found)
                missing += absent
        except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
            raise DataError(f"Invalid fixture archive {path}: {exc}") from exc
        target = resolve_relative(settings.source, name)
        if path.resolve() != target.resolve():
            with path.open("rb") as source, atomic_output(target) as output:
                shutil.copyfileobj(source, output)
        hashes[name] = file_hash(target)
    return _receipt(
        settings,
        "fixture",
        rows,
        response_bytes=0,
        missing_pairs=missing,
        archive_sha256=hashes,
    )


@contextmanager
def open_member_reader(source_root: Path) -> Iterator[Callable[[str, str], bytes]]:
    """Verify local archive identity once and reuse open ZIP readers."""
    try:
        receipt = read_json(source_root / "source-receipt.json")
        with ExitStack() as stack:
            archives = {}
            for name in (TRAIN_ARCHIVE, TEST_ARCHIVE):
                path = resolve_relative(source_root, name)
                if path.exists():
                    expected = receipt.get("archive_sha256", {}).get(name)
                    if not expected or file_hash(path) != expected:
                        raise DataError(f"Archive cache failed verification: {name}")
                    archives[name] = stack.enter_context(zipfile.ZipFile(path))

            def read(source_archive: str, member_path: str) -> bytes:
                if source_archive not in (TRAIN_ARCHIVE, TEST_ARCHIVE):
                    raise DataError("Unknown source archive")
                relative_parts(member_path)
                try:
                    if source_archive in archives:
                        info = archives[source_archive].getinfo(member_path)
                        _safe(info)
                        return archives[source_archive].read(info)
                    key = source_archive + ":" + member_path
                    expected = receipt.get("members", {}).get(key)
                    if not expected:
                        raise DataError(f"Member is not in verified receipt: {key}")
                    path = resolve_relative(
                        source_root / "members", source_archive + "/" + member_path
                    )
                    data = path.read_bytes()
                    if hashlib.sha256(data).hexdigest() != expected:
                        raise DataError(f"Member cache failed verification: {key}")
                    return data
                except (OSError, KeyError, ValueError, zipfile.BadZipFile) as exc:
                    raise DataError(
                        f"Cannot read verified member {member_path}: {exc}"
                    ) from exc

            yield read
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise DataError(f"Cannot open verified source: {exc}") from exc


def read_member(source_root: Path, source_archive: str, member_path: str) -> bytes:
    """Read one verified member; use open_member_reader for batch work."""
    with open_member_reader(source_root) as read:
        return read(source_archive, member_path)


class _TransientSourceError(DataError):
    """A source connection failure that can be retried."""

@contextmanager
def _source_response(
    request: str | urllib.request.Request,
    operation: str,
    max_attempts: int = 4,
) -> Iterator[HTTPResponse]:
    """Open an HTTP response with bounded retries for transient failures."""
    if max_attempts < 1:
        raise ValueError("max_attempts must be at least 1")

    url = (
        request.full_url
        if isinstance(request, urllib.request.Request)
        else request
    )
    hostname = urllib.parse.urlsplit(url).hostname

    for attempt in range(max_attempts):
        try:
            response = urllib.request.urlopen(request, timeout=60)

        except OSError as exc:
            keylog = os.environ.get("SSLKEYLOGFILE")

            if (
                isinstance(exc, FileNotFoundError)
                and keylog
                and exc.filename == keylog
            ):
                raise DataError(
                    f"{operation}: TLS key log path is missing. "
                    "Clear SSLKEYLOGFILE or set it to a file "
                    "in an existing directory."
                ) from exc

            reason = (
                exc.reason
                if isinstance(exc, urllib.error.URLError)
                else exc
            )

            if isinstance(reason, ssl.SSLCertVerificationError):
                raise DataError(
                    f"{operation}: TLS certificate verification failed "
                    f"for {hostname} ({url}): {reason}"
                ) from exc

            if attempt == max_attempts - 1:
                raise _TransientSourceError(
                    f"{operation}: connection failed after "
                    f"{max_attempts} attempts for {url}: {exc}"
                ) from exc

            delay = min(2 ** attempt, 8) + random.uniform(0, 0.5)
            time.sleep(delay)
            continue

        # Keep response reading outside the connection retry handler.
        # The caller is responsible for handling interrupted reads.
        with response:
            yield response
        return



class RangeFile(io.RawIOBase):
    def __init__(self, url: str, size: int, cap: int):
        self.url, self.size, self.cap = url, size, cap
        self.position = 0
        self.total = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = 0) -> int:
        self.position = offset + (
            0 if whence == 0 else self.position if whence == 1 else self.size
        )
        if self.position < 0:
            raise ValueError("Negative seek")
        return self.position

    def read(self, size: int = -1) -> bytes:
        size = min(
            self.size - self.position,
            size if size >= 0 else self.size - self.position,
        )

        if size <= 0:
            return b""

        if size > self.cap - self.total:
            raise DataError("Archive response byte budget exceeded", "byte_cap")

        chunks = []
        remaining = size
        max_attempts = 5
        attempt = 0

        while remaining:
            start = self.position + (size - remaining)
            end = self.position + size - 1

            request = urllib.request.Request(
                self.url,
                headers={
                    "Range": f"bytes={start}-{end}",
                    "Accept-Encoding": "identity",
                    "User-Agent": "CSC173-referee-data/1.0",
                },
            )

            try:
                with _source_response(
                    request,
                    f"Read ATYPICT archive bytes {start}-{end}",
                    max_attempts=1,
                ) as response:

                    if (
                        response.status != 206
                        or response.headers.get("Content-Range")
                        != f"bytes {start}-{end}/{self.size}"
                    ):
                        raise DataError(
                            "Server did not honour the exact archive range"
                        )

                    while remaining:
                        try:
                            chunk = response.read(min(remaining, 65536))

                        except IncompleteRead as exc:
                            # IncompleteRead may contain bytes received before
                            # the connection was interrupted.
                            partial = exc.partial or b""

                            if len(partial) > remaining:
                                raise DataError(
                                    "Archive response exceeded requested range"
                                ) from exc

                            if partial:
                                chunks.append(partial)
                                self.total += len(partial)
                                remaining -= len(partial)

                            raise OSError(
                                "Truncated archive response"
                            ) from exc

                        if not chunk:
                            raise DataError(
                                f"Truncated archive response at byte "
                                f"{self.position + size - remaining}"
                            )

                        if len(chunk) > remaining:
                            raise DataError(
                                "Archive response exceeded requested range"
                            )

                        chunks.append(chunk)
                        self.total += len(chunk)
                        remaining -= len(chunk)

                # Reset retry counter after a successfully completed response.
                attempt = 0

            except (OSError, _TransientSourceError) as exc:
                attempt += 1

                if attempt >= max_attempts:
                    raise DataError(
                        f"Read ATYPICT archive bytes "
                        f"{self.position}-{self.position + size - 1} "
                        f"failed after {max_attempts} attempts: {exc}"
                    ) from exc

                delay = min(2 ** (attempt - 1), 8) + random.uniform(0, 0.5)

                print(
                    f"Connection interrupted. Resuming at byte "
                    f"{self.position + size - remaining:,} "
                    f"(attempt {attempt + 1}/{max_attempts})..."
                )

                time.sleep(delay)

        self.position += size
        return b"".join(chunks)


class Slice(io.RawIOBase):
    def __init__(self, parent: RangeFile, offset: int, size: int):
        self.parent, self.offset, self.size, self.position = parent, offset, size, 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = 0) -> int:
        self.position = offset + (
            0 if whence == 0 else self.position if whence == 1 else self.size
        )
        if self.position < 0:
            raise ValueError("Negative seek")
        return self.position

    def read(self, size: int = -1) -> bytes:
        size = min(
            self.size - self.position, size if size >= 0 else self.size - self.position
        )
        if size <= 0:
            return b""
        self.parent.seek(self.offset + self.position)
        data = self.parent.read(size)
        self.position += len(data)
        return data


def _nested(remote: RangeFile, info: zipfile.ZipInfo) -> zipfile.ZipFile:
    if info.compress_type != zipfile.ZIP_STORED or info.file_size != info.compress_size:
        raise DataError("Nested ZIP must be stored in the outer archive")
    remote.seek(info.header_offset)
    header = remote.read(30)
    if header[:4] != b"PK\x03\x04":
        raise DataError("Invalid nested ZIP header")
    name_size, extra_size = struct.unpack_from("<HH", header, 26)
    return zipfile.ZipFile(
        Slice(remote, info.header_offset + 30 + name_size + extra_size, info.file_size)
    )


def download(settings: Settings) -> dict:
    """Explicitly retrieve the pinned source, constrained to its multiclass subset."""
    is_sample = settings.profile == "sample"
    source_kind = "atypict_range_sample" if is_sample else "atypict_range_multiclass"
    with _source_response(SOURCE_API, f"Fetch Zenodo record {RECORD_ID}") as response:
        metadata = json.load(response)
    files = [
        item for item in metadata.get("files", []) if item.get("key") == ARCHIVE_NAME
    ]
    if len(files) != 1 or str(metadata.get("id")) != RECORD_ID:
        raise DataError("Zenodo metadata does not match the pinned record")
    entry = files[0]
    if (
        entry.get("size") != ARCHIVE_SIZE
        or entry.get("checksum") != "md5:" + ARCHIVE_MD5
    ):
        raise DataError("Zenodo archive pin changed")
    atomic_json(settings.source / "zenodo-record.json", metadata)
    remote = RangeFile(
        entry["links"]["self"],
        ARCHIVE_SIZE,
        SAMPLE_BYTE_CAP if is_sample else ARCHIVE_SIZE * 3,
    )
    rows: list[dict] = []
    members: dict[str, str] = {}
    archive_sha256: dict[str, str] = {}
    missing = 0
    receipt_path = settings.source / "source-receipt.json"
    if receipt_path.exists():
        previous = read_json(receipt_path)
        if (
            previous.get("record_id") != RECORD_ID
            or previous.get("archive_size") != ARCHIVE_SIZE
            or previous.get("archive_md5") != ARCHIVE_MD5
            or previous.get("profile") != settings.profile
            or previous.get("source_kind") != source_kind
        ):
            raise DataError(
                "Existing source receipt belongs to a different profile or route"
            )
        members = previous.get("members", {})
        archive_sha256 = previous.get("archive_sha256", {})
    archive_names = (TRAIN_ARCHIVE,) if is_sample else (TRAIN_ARCHIVE, TEST_ARCHIVE)
    with zipfile.ZipFile(remote) as outer:
        for source_archive in archive_names:
            name = "DrawMon-ACMMM22_Dataset/" + source_archive
            info = outer.getinfo(name)
            _safe(info)
            if not is_sample:
                if (
                    info.compress_type != zipfile.ZIP_STORED
                    or info.compress_size != info.file_size
                ):
                    raise DataError("Nested ZIP must be stored in the outer archive")
                target = resolve_relative(settings.source, source_archive)
                expected = archive_sha256.get(source_archive)
                valid = bool(
                    expected
                    and target.exists()
                    and target.stat().st_size == info.file_size
                    and file_hash(target) == expected
                )
                if not valid:
                    # ZipExtFile verifies the outer member CRC while streaming to a partial file.
                    with outer.open(info) as source, atomic_output(target) as output:
                        shutil.copyfileobj(source, output, length=1024 * 1024)
                    if target.stat().st_size != info.file_size:
                        raise DataError(
                            f"Nested archive size mismatch: {source_archive}"
                        )
                    archive_sha256[source_archive] = file_hash(target)
                with zipfile.ZipFile(target) as inner:
                    found, absent = _pairs(inner, source_archive)
                rows.extend(found)
                missing += absent
                _receipt(
                    settings,
                    source_kind,
                    rows,
                    response_bytes=remote.total,
                    archive_sha256=archive_sha256,
                    missing_pairs=missing,
                    in_progress=True,
                )
                continue
            with _nested(remote, info) as inner:
                found, absent = _pairs(inner, source_archive)
                missing += absent
                ranked = sorted(
                    found,
                    key=lambda row: hashlib.sha256(
                        f"{settings.seed}:{row['sample_id']}".encode()
                    ).digest(),
                )
                counts: dict[str, int] = {}
                selected = []
                for row in ranked:
                    folder = row["provenance_folder"]
                    count = counts.get(folder, 0)
                    if count >= SAMPLE_PER_FOLDER:
                        continue
                    selected.append(row)
                    counts[folder] = count + 1
                    if len(selected) == 10:
                        break
                for row in sorted(selected, key=lambda row: row["sample_id"]):
                    for field in (
                        "png_member",
                        "sample_npy_member",
                        "label_npy_member",
                    ):
                        member = row[field]
                        key = source_archive + ":" + member
                        target = resolve_relative(
                            settings.source / "members", source_archive + "/" + member
                        )
                        if (
                            key in members
                            and target.exists()
                            and file_hash(target) == members[key]
                        ):
                            continue
                        data = inner.read(member)
                        with atomic_output(target) as output:
                            output.write(data)
                        members[key] = hashlib.sha256(data).hexdigest()
                        # Persist each verified member so a stopped run can resume.
                        _receipt(
                            settings,
                            source_kind,
                            rows,
                            response_bytes=remote.total,
                            members=members,
                            missing_pairs=missing,
                            in_progress=True,
                        )
                    rows.append(row)
    return _receipt(
        settings,
        source_kind,
        rows,
        response_bytes=remote.total,
        members=members,
        archive_sha256=archive_sha256,
        missing_pairs=missing,
        in_progress=False,
    )
