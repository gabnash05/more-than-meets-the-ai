"""Validate repository-map paths and tracked entry-point documentation coverage."""

import re
import subprocess
import sys
from pathlib import Path


def is_entry_point(entry: str) -> bool:
    """Return whether a tracked path must appear literally in the map.

    Coverage covers every tracked README, every Markdown document under docs/ and
    the repository instruction files, so a new project area has to be routed when
    it lands rather than only when someone remembers to widen this rule.
    """
    path = Path(entry)
    return (
        path.name == "README.md"
        or path.name in {"AGENTS.md", "CLAUDE.md"}
        or (path.suffix == ".md" and entry.startswith("docs/"))
    )


def check_map(root: Path, tracked: list[str], text: str) -> list[str]:
    """Return missing indexed paths and uncovered tracked documentation."""
    indexed = set(re.findall(r"`([^`\n]+)`", text))
    errors = []
    for entry in sorted(indexed):
        # Only literal path tokens are checked, not commands or prose labels.
        if (
            " " not in entry
            and (
                "/" in entry
                or entry.endswith(".md")
                or entry in {".gitignore", ".gitattributes"}
            )
            and not (root / entry).exists()
        ):
            errors.append(f"Indexed path does not exist: {entry}")
    for entry in sorted(tracked):
        if is_entry_point(entry) and entry not in indexed:
            errors.append(f"Unindexed entry-point document: {entry}")
    return errors


def main() -> int:
    """Read tracked paths without opening project files or running workloads."""
    root = Path(__file__).resolve().parents[4]
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        check=True,
        capture_output=True,
        text=True,
    )
    tracked = [entry for entry in result.stdout.split("\0") if entry]
    reference = root / ".agents/skills/onboarding/references/repository-map.md"
    errors = check_map(root, tracked, reference.read_text(encoding="utf-8"))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Repository map: indexed paths exist; tracked entry-point coverage passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
