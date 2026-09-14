"""Restart current project code from one recorded SpaceTimePy snapshot."""

from __future__ import annotations

import argparse
import asyncio
import inspect
import sys
from pathlib import Path
from types import FunctionType, ModuleType
from typing import Any

from spacetimepy import SpaceTime

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from spacetimepy_vscode_runtime.hotswap import (
    call_arguments_from_locals,
    prepare_snapshot_replay,
)
from spacetimepy_vscode_runtime.launch import _load_module


def _restore_globals(module: ModuleType, values: dict[str, Any]) -> None:
    for name, value in values.items():
        if name.startswith("_spacetimepy_") or name == "__builtins__":
            continue
        if isinstance(value, ModuleType) or inspect.isroutine(value) or inspect.isclass(value):
            continue
        module.__dict__[name] = value


def _call(function: FunctionType, values: dict[str, Any]) -> Any:
    positional, keywords = call_arguments_from_locals(function, values)
    result = function(*positional, **keywords)
    return asyncio.run(result) if inspect.isawaitable(result) else result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--target-file", required=True)
    parser.add_argument("--function", required=True)
    parser.add_argument("--parent-branch", required=True, type=int)
    parser.add_argument("--forked-from-step", required=True, type=int)
    parser.add_argument("--launch-id", required=True)
    args = parser.parse_args()

    target_file = Path(args.target_file).resolve()
    module = _load_module(target_file)
    target = getattr(module, args.function)
    if not isinstance(target, FunctionType):
        raise TypeError(f"{args.function!r} is not a top-level Python function")

    with SpaceTime.open(args.database) as space:
        context = space.replay.prepare(
            parent_branch_id=args.parent_branch,
            forked_from_step_id=args.forked_from_step,
        )
        source_snapshot = context.forked_from_step.stack_snapshot
        if source_snapshot is None or source_snapshot.code_definition_id is None:
            raise RuntimeError("The selected step is not a recorded line snapshot")
        recorded_code = space.data.get_code_definition(
            source_snapshot.code_definition_id
        )
        target = prepare_snapshot_replay(
            target,
            locals=context.locals,
            source_line=source_snapshot.line_number,
            recorded_source=recorded_code.code_content,
            recorded_first_line=recorded_code.first_line_number or source_snapshot.line_number,
        )
        space.replay.begin(
            parent_branch_id=args.parent_branch,
            forked_from_step_id=args.forked_from_step,
            name="VS Code snapshot replay",
            recipe={
                "integration": "spacetimepy-vscode",
                "operation": "snapshot-replay",
                "launch_id": args.launch_id,
            },
        )
        _restore_globals(module, context.globals)
        target = space.capture.line(
            target,
            # The debugger first stops at the injected entry trampoline.
            # hotswap.finish() records the restored snapshot at its mapped
            # source line and then enables ordinary line capture.
            lines=set(),
            ignored_names={
                "_spacetimepy_hotswap_result",
                "_spacetimepy_hotswap_entry",
                "_spacetimepy_hotswap_continue",
            },
        )
        try:
            _call(target, context.locals)
        except BaseException:
            space.replay.finish("failed")
            raise
        else:
            space.replay.finish()


if __name__ == "__main__":
    main()
