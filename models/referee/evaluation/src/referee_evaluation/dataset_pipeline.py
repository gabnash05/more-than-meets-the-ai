"""Build and parse the Referee data CLI commands used by the notebook."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

COMMANDS = ("download", "prepare", "preview", "export")
PROFILES = ("sample", "train")


@dataclass(frozen=True)
class PipelineOptions:
    """One data-profile selection for the separate CPU data project."""

    data_root: Path
    profile: str
    project: Path

    def command(self, step: str) -> list[str]:
        """Return one locked CPU-data command; never execute it here."""
        if step not in COMMANDS:
            raise ValueError(f"Unknown Referee data step: {step}")
        if self.profile not in PROFILES:
            raise ValueError(f"Unknown Referee data profile: {self.profile}")
        return [
            "uv", "run", "--project", str(self.project),
            "--frozen", "--no-dev", "referee-data", step,
            "--data-root", str(self.data_root),
            "--profile", self.profile, "--json",
        ]


def parse_report(stdout: str) -> dict:
    """Parse the CLI's --json envelope and reject unrelated output."""
    payload = json.loads(stdout)
    if not isinstance(payload, dict) or payload.get("command") not in COMMANDS:
        raise ValueError("Referee data CLI did not return a command report.")
    return payload


def run_step(options: PipelineOptions, step: str, env: Mapping[str, str]) -> dict:
    """Run one data step and return its parsed report.

    The caller decides which steps are enabled. This function never retries or
    downloads on its own, and it surfaces stderr instead of swallowing failures.
    """
    result = subprocess.run(
        options.command(step),
        cwd=options.project,
        env=dict(env),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"Referee data step failed: {step}")
    return parse_report(result.stdout)
