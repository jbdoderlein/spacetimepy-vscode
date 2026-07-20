"""Launch one project function under a SpaceTimePy line recording."""

from __future__ import annotations

import argparse
import asyncio
import importlib
import importlib.util
import inspect
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

from spacetimepy import SpaceTime

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from spacetimepy_vscode_runtime.hotswap import (
    call_arguments_from_locals,
    captured_line_numbers,
    hotswappable,
)


def _load_module(target_file: Path) -> ModuleType:
    package_parts = [target_file.stem]
    package_root = target_file.parent
    while (package_root / "__init__.py").is_file():
        package_parts.insert(0, package_root.name)
        package_root = package_root.parent

    if len(package_parts) > 1:
        sys.path.insert(0, str(package_root))
        return importlib.import_module(".".join(package_parts))

    module_name = f"_spacetimepy_vscode_{target_file.stem}"
    specification = importlib.util.spec_from_file_location(module_name, target_file)
    if specification is None or specification.loader is None:
        raise ImportError(f"Cannot import {target_file}")
    module = importlib.util.module_from_spec(specification)
    sys.modules[module_name] = module
    specification.loader.exec_module(module)
    return module


def _call(function: Any, arguments: str, namespace: dict[str, Any]) -> Any:
    local_namespace = {"_spacetimepy_vscode_target": function}
    result = eval(  # noqa: S307 - the user explicitly enters Python call arguments
        f"_spacetimepy_vscode_target({arguments})",
        namespace,
        local_namespace,
    )
    return asyncio.run(result) if inspect.isawaitable(result) else result


def _call_from_locals(function: Any, values: dict[str, Any]) -> Any:
    positional, keywords = call_arguments_from_locals(function, values)
    result = function(*positional, **keywords)
    return asyncio.run(result) if inspect.isawaitable(result) else result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--target-file", required=True)
    parser.add_argument("--function", required=True)
    parser.add_argument("--arguments", default="")
    parser.add_argument("--arguments-call-id", type=int)
    parser.add_argument("--launch-id", required=True)
    args = parser.parse_args()

    target_file = Path(args.target_file).resolve()
    module = _load_module(target_file)
    function = getattr(module, args.function)
    function = hotswappable(function)
    session_name = f"VS Code debug: {args.function} [{args.launch_id}]"

    with SpaceTime.open(args.database) as space:
        captured = space.capture.line(
            function,
            lines=captured_line_numbers(function),
            ignored_names={
                "_spacetimepy_hotswap_result",
                "_spacetimepy_hotswap_entry",
                "_spacetimepy_hotswap_continue",
            },
        )
        with space.capture.recording(
            mode="line",
            name=session_name,
            attributes={
                "integration": "spacetimepy-vscode",
                "launch_id": args.launch_id,
                "source_file": str(target_file),
                "function": args.function,
            },
        ):
            if args.arguments_call_id is None:
                _call(captured, args.arguments, module.__dict__)
            else:
                previous_call = space.data.get_function_call(args.arguments_call_id)
                if previous_call.function_name != args.function:
                    raise ValueError(
                        f"Call {args.arguments_call_id} recorded "
                        f"{previous_call.function_name!r}, not {args.function!r}"
                    )
                previous_locals = space.data.load_references(
                    previous_call.entry_local_references
                )
                _call_from_locals(captured, previous_locals)


if __name__ == "__main__":
    main()
