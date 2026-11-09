"""Command-line entry points for Referee data preparation."""

import argparse
import json
import sys
from pathlib import Path

from .common import DataError, load_step
from .settings import DEFAULT_DATA_ROOT, PROFILES, Settings

_COMMANDS = {
    "download": ("01-download", "download", "Cache a pinned ATYPICT profile."),
    "prepare": ("02-prepare", "prepare", "Build labeled PNGs and grouped splits."),
    "preview": ("03-preview", "preview", "Render optional training contact sheets."),
    "export": ("04-export", "export_dataset", "Audit and write portable ZIPs."),
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="referee-data", description="Prepare CPU-only Referee data."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    helps = {name: spec[2] for name, spec in _COMMANDS.items()}
    helps["example"] = "Run the complete synthetic workflow without source downloads."
    for name, description in helps.items():
        step = commands.add_parser(name, help=description, description=description)
        step.add_argument(
            "--data-root", type=Path, default=DEFAULT_DATA_ROOT, metavar="DIRECTORY"
        )
        step.add_argument(
            "--profile",
            choices=("sample",) if name == "example" else PROFILES,
            default="sample",
        )
        step.add_argument(
            "--json", action="store_true", help="Print the stage result as JSON."
        )
    return parser


def _example(settings: Settings) -> dict:
    from .example import build_example_files

    archives = build_example_files(settings.base)
    source = load_step("01-download").stage_fixture(settings, archives)
    prepared = load_step("02-prepare").prepare(settings)
    preview = load_step("03-preview").preview(settings)
    exports = load_step("04-export").export_dataset(settings)
    return {
        "source": source,
        "counts": prepared["counts"],
        "preview": preview,
        "exports": exports,
    }


def _print_result(command: str, settings: Settings, result: dict) -> None:
    print(f"{command} complete [{settings.profile}]")
    print(f"Data: {settings.base}")
    source = result.get("source", result)
    if "pair_count" in source:
        print(
            f"Source: {source['pair_count']} pairs, {source['response_bytes']} archive bytes"
        )
    for split, counts in result.get("counts", {}).items():
        print(f"{split}: {counts['rows']} prepared rows")
    if command in ("example", "export"):
        print(f"Packages and checksums: {settings.exports}")
    elif command == "preview":
        print(f"Contact sheets: {settings.previews}")


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    root = args.data_root / "example" if args.command == "example" else args.data_root
    settings = Settings(data_root=root, profile=args.profile)
    try:
        if args.command == "example":
            result = _example(settings)
        else:
            step, method, _ = _COMMANDS[args.command]
            result = getattr(load_step(step), method)(settings)
    except (DataError, OSError) as exc:
        print(f"{args.command} failed: {exc}", file=sys.stderr)
        return 1
    if args.json:
        report = {
            "command": args.command,
            "profile": settings.profile,
            "data_root": str(settings.base),
            "result": result,
        }
        print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    else:
        _print_result(args.command, settings, result)
    return 0
