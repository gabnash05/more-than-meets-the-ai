"""Tests for notebook-managed subprocess shutdown behavior."""

from __future__ import annotations

import _thread
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from guesser_evaluation.notebook_tools import run_interruptible_command


def test_keyboard_interrupt_requests_child_shutdown_and_returns_cleanly(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Forward a notebook interrupt and wait for the child to handle it."""
    ready_path = tmp_path / "child-ready"
    stopped_path = tmp_path / "child-stopped"
    child_code = f"""
import signal
import time
from pathlib import Path
ready = Path({str(ready_path)!r})
stopped = Path({str(stopped_path)!r})
def stop(signum, frame):
    stopped.write_text(str(signum), encoding="utf-8")
    raise SystemExit(0)
signal.signal(signal.SIGINT, stop)
if hasattr(signal, "SIGBREAK"):
    signal.signal(signal.SIGBREAK, stop)
ready.write_text("ready", encoding="utf-8")
while True:
    time.sleep(0.05)
"""
    interrupt_sent = threading.Event()

    def interrupt_after_child_is_ready() -> None:
        """Interrupt the notebook thread only after the child installs handlers."""
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not ready_path.is_file():
            time.sleep(0.01)
        interrupt_sent.set()
        _thread.interrupt_main()

    interrupter = threading.Thread(target=interrupt_after_child_is_ready, daemon=True)
    interrupter.start()
    completed = run_interruptible_command(
        [sys.executable, "-c", child_code],
        cwd=tmp_path,
        env=os.environ.copy(),
        shutdown_timeout=3,
    )
    interrupter.join(timeout=2)

    assert interrupt_sent.is_set()
    assert stopped_path.is_file()
    assert completed is False
    assert "interrupt" in capsys.readouterr().out.lower()


def test_nonzero_exit_is_not_reported_as_success(tmp_path: Path) -> None:
    """Keep command failures visible instead of treating them as cancellation."""
    with pytest.raises(subprocess.CalledProcessError) as error:
        run_interruptible_command(
            [sys.executable, "-c", "raise SystemExit(7)"],
            cwd=tmp_path,
            env=os.environ.copy(),
            shutdown_timeout=3,
        )

    assert error.value.returncode == 7
