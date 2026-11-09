'''Portable helpers for targeting the Guesser source package from notebooks.'''

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections.abc import Mapping, Sequence
from pathlib import Path


def module_source_path(filename: str, start: Path | None = None) -> Path:
    '''Return a Python module path inside the workspace's src package.

    The search accepts a starting directory inside either the repository root or
    the Guesser workspace, so notebook kernels can resolve the same source tree
    without hardcoded machine-specific paths.
    '''
    if (
        Path(filename).name != filename
        or "/" in filename
        or "\\" in filename
        or Path(filename).suffix != ".py"
    ):
        raise ValueError("Pass a single .py filename in the package root.")

    current = (start or Path.cwd()).resolve()
    for parent in (current, *current.parents):
        for project_root in (parent, parent / "models" / "guesser" / "evaluation"):
            package_dir = project_root / "src" / "guesser_evaluation"
            if (project_root / "pyproject.toml").is_file() and package_dir.is_dir():
                return (package_dir / filename).resolve()

    raise FileNotFoundError("Could not locate the Guesser source package from this directory.")


def run_interruptible_command(
    command: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    shutdown_timeout: float = 120.0,
) -> bool:
    """Run a long command with notebook-aware cancellation and visible output.

    Args:
        command: Executable and arguments, passed directly without a shell.
        cwd: Working directory for the child process.
        env: Explicit environment mapping for the child process.
        shutdown_timeout: Seconds to wait for graceful shutdown after an interrupt.

    Returns:
        True after a successful command; False after a user interrupt and child shutdown.

    Raises:
        ValueError: If command is empty or shutdown_timeout is not positive.
        OSError: If the child cannot start or forced shutdown cannot be completed.
        subprocess.CalledProcessError: If the child exits unsuccessfully without interruption.

    Side effects:
        Starts a child process, streams its output to the notebook, and may signal or
        terminate the child process tree when the user interrupts the cell.
    """
    if not command:
        raise ValueError("command must contain an executable")
    if shutdown_timeout <= 0:
        raise ValueError("shutdown_timeout must be positive")

    # Isolate the child so Jupyter's interrupt targets the kernel; this helper
    # then forwards one controlled interrupt to the training process.
    if os.name == "nt":
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    else:
        process = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)

    try:
        return_code = _wait_for_completion(process)
    except KeyboardInterrupt:
        print(
            "Interrupt received; asking the training process to stop cleanly.",
            flush=True,
        )
        try:
            _send_process_interrupt(process)
        except OSError as error:
            print(f"Could not send a graceful interrupt ({error}); escalating shutdown.", flush=True)
            _terminate_process_tree(process)
        else:
            if _wait_for_process(process, shutdown_timeout) is None:
                print(
                    f"Training did not stop within {shutdown_timeout:g} seconds; "
                    "terminating its process tree.",
                    flush=True,
                )
                _terminate_process_tree(process)

        print(
            "Training process exited after the interrupt.",
            flush=True,
        )
        return False

    if return_code != 0:
        raise subprocess.CalledProcessError(return_code, command)
    return True


def _send_process_interrupt(process: subprocess.Popen[bytes]) -> None:
    """Send one platform-appropriate interrupt to the isolated child launcher.

    Args:
        process: Running child process created in its own session/group.

    Raises:
        OSError: If the operating system cannot deliver the interrupt.
    """
    if process.poll() is not None:
        return

    # uv forwards this signal to its Python child; Windows needs a console break
    # event for the isolated process group created above.
    if os.name == "nt":
        interrupt_signal = signal.CTRL_BREAK_EVENT
    else:
        interrupt_signal = signal.SIGINT
    process.send_signal(interrupt_signal)


def _wait_for_process(
    process: subprocess.Popen[bytes], timeout: float
) -> int | None:
    """Wait up to timeout seconds, tolerating repeated notebook interrupts.

    Args:
        process: Child process to wait for.
        timeout: Maximum wait duration in seconds.

    Returns:
        The process exit code, or None when the timeout expires.
    """
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        try:
            return process.wait(timeout=remaining)
        except KeyboardInterrupt:
            # Keep waiting after an additional UI interrupt; cleanup is already underway.
            print("Still waiting for the trainer to shut down cleanly.", flush=True)
        except subprocess.TimeoutExpired:
            return None


def _wait_for_completion(process: subprocess.Popen[bytes]) -> int:
    """Poll until the child exits so the notebook can process interrupts.

    Args:
        process: Child process to wait for.

    Returns:
        The process exit code.
    """
    while True:
        # Bounded waits let Python deliver a pending KeyboardInterrupt promptly.
        try:
            return process.wait(timeout=0.2)
        except subprocess.TimeoutExpired:
            continue


def _terminate_process_tree(process: subprocess.Popen[bytes]) -> None:
    """Force-stop the isolated process tree after graceful shutdown times out.

    Args:
        process: Child process whose isolated tree must be stopped.

    Side effects:
        Sends termination signals to the process tree and reaps its leader.
    """
    if os.name == "nt":
        # taskkill /T is the Windows equivalent of signalling the whole process group.
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            text=True,
        )
        if process.poll() is None:
            process.kill()
        _wait_for_process(process, 10.0)
        return

    # On POSIX, terminate all members of the isolated session, then kill only if needed.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if _wait_for_process(process, 10.0) is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _wait_for_process(process, 10.0)
