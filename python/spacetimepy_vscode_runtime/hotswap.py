"""Debugger-owned live-code replacement used by SpaceTimePy launch sessions.

The module owns code reload, local-state migration, and debugpy redirection.
SpaceTimePy itself is notified only when the replacement frame exists so it
can transfer the logical call into a child execution branch.
"""

from __future__ import annotations

import ast
import ctypes
import importlib
import importlib.util
import inspect
import linecache
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path
from types import FrameType, FunctionType, ModuleType
from typing import Any

from bytecode import Bytecode, Instr, Label
from spacetimepy import get_active_spacetime


_ENTRY_NAME = "_spacetimepy_hotswap_entry"
_CONTINUE_NAME = "_spacetimepy_hotswap_continue"
_PREPARE_NAME = "_spacetimepy_hotswap_prepare"
_FINISH_NAME = "_spacetimepy_hotswap_finish"
_TEMPORARY_NAME = "_spacetimepy_hotswap_result"
_CONTINUE = object()


@dataclass
class _SourceVersion:
    content: str
    start_line: int
    end_line: int


@dataclass
class _HotSwapState:
    function_name: str
    file_path: Path
    source: _SourceVersion
    first_body_line: int
    trampoline_line: int
    pending: bool = False
    source_frame: FrameType | None = None
    replacement_source_frame: FrameType | None = None
    replacement_frame: FrameType | None = None
    target_line: int | None = None
    old_line: int | None = None
    replacement_source: _SourceVersion | None = None
    saved_locals: dict[str, Any] | None = None
    initial_replay_locals: dict[str, Any] | None = None
    replacement_state_recorded: bool = False


def _function_source(file_path: Path, function_name: str) -> _SourceVersion:
    content = file_path.read_text(encoding="utf-8")
    tree = ast.parse(content, filename=str(file_path))
    node = next(
        (
            candidate
            for candidate in tree.body
            if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef))
            and candidate.name == function_name
        ),
        None,
    )
    if node is None or node.end_lineno is None:
        raise RuntimeError(f"Cannot find top-level function {function_name!r} in {file_path}")
    lines = content.splitlines()
    return _SourceVersion(
        content="\n".join(lines[node.lineno - 1 : node.end_lineno]),
        start_line=node.lineno,
        end_line=node.end_lineno,
    )


def _mapped_line(old: _SourceVersion, new: _SourceVersion, old_line: int) -> int:
    old_lines = old.content.splitlines()
    new_lines = new.content.splitlines()
    relative = max(0, min(old_line - old.start_line, len(old_lines) - 1))
    matcher = SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
    for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        if old_start <= relative < old_end:
            if tag == "equal":
                mapped = new_start + (relative - old_start)
            elif new_end > new_start:
                mapped = new_start + min(relative - old_start, new_end - new_start - 1)
            else:
                mapped = min(new_start, max(0, len(new_lines) - 1))
            return new.start_line + mapped
    return new.start_line + min(relative, max(0, len(new_lines) - 1))


def _set_next_line(line: int, function_name: str) -> None:
    try:
        try:
            import pydevd  # type: ignore[import-not-found]
        except ModuleNotFoundError:
            # Importing this module exposes debugpy's vendored pydevd package.
            from debugpy._vendored import force_pydevd  # noqa: F401

            import pydevd  # type: ignore[import-not-found,no-redef]

        thread = pydevd.threadingCurrentThread()
        if thread is None:
            raise RuntimeError("debugpy did not expose the current debugger thread")
        info = thread.additional_info
        info.pydev_original_step_cmd = pydevd.CMD_SET_NEXT_STATEMENT
        info.pydev_step_cmd = pydevd.CMD_SET_NEXT_STATEMENT
        info.pydev_step_stop = None
        info.pydev_next_line = int(line)
        info.pydev_func_name = function_name
        info.pydev_message = str(line)
        info.pydev_smart_parent_offset = -1
        info.pydev_smart_child_offset = -1
        info.pydev_state = pydevd.STATE_RUN
        info.update_stepping_info()
    except Exception as error:
        raise RuntimeError(
            "SpaceTimePy could not redirect debugpy to the replacement line"
        ) from error


def _reload_module(module: ModuleType, file_path: Path) -> ModuleType:
    importlib.invalidate_caches()
    linecache.clearcache()
    try:
        return importlib.reload(module)
    except ModuleNotFoundError:
        specification = importlib.util.spec_from_file_location(module.__name__, file_path)
        if specification is None or specification.loader is None:
            raise ImportError(f"Cannot reload {file_path}")
        module.__spec__ = specification
        specification.loader.exec_module(module)
        return module


def _call_arguments(function: FunctionType, frame: FrameType) -> tuple[list[Any], dict[str, Any]]:
    positional: list[Any] = []
    keywords: dict[str, Any] = {}
    for parameter in inspect.signature(function).parameters.values():
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            positional.extend(frame.f_locals.get(parameter.name, ()))
        elif parameter.kind is inspect.Parameter.VAR_KEYWORD:
            keywords.update(frame.f_locals.get(parameter.name, {}))
        elif parameter.name in frame.f_locals:
            if parameter.kind is inspect.Parameter.POSITIONAL_ONLY:
                positional.append(frame.f_locals[parameter.name])
            else:
                keywords[parameter.name] = frame.f_locals[parameter.name]
    return positional, keywords


def _restore_locals(frame: FrameType, values: dict[str, Any]) -> None:
    for name, value in values.items():
        if not name.startswith("_spacetimepy_hotswap_") and not name.startswith("__pydevd"):
            frame.f_locals[name] = value
    # Python 3.12 still exposes a snapshot-like locals mapping for optimized
    # frames.  Synchronize it explicitly; on newer versions this is harmless.
    locals_to_fast = getattr(ctypes.pythonapi, "PyFrame_LocalsToFast", None)
    if locals_to_fast is not None:
        locals_to_fast.argtypes = [ctypes.py_object, ctypes.c_int]
        locals_to_fast.restype = None
        locals_to_fast(frame, 0)


def _bind_unbound_locals(frame: FrameType) -> None:
    """Make debugpy's unavoidable set-next local normalization explicit."""

    current = frame.f_locals
    missing = {
        name: None
        for name in frame.f_code.co_varnames[: frame.f_code.co_nlocals]
        if name not in current
    }
    if missing:
        _restore_locals(frame, missing)


def _injection_instructions(line_number: int) -> list[Instr | Label]:
    def template() -> None:
        result = _spacetimepy_hotswap_entry()  # noqa: F821
        if result is not _spacetimepy_hotswap_continue:  # noqa: F821
            return result  # type: ignore[return-value]
        _spacetimepy_hotswap_injection_boundary()  # noqa: F821

    instructions: list[Instr | Label] = []
    for item in Bytecode.from_code(template.__code__):
        if isinstance(item, Instr) and item.name == "RESUME":
            continue
        if (
            isinstance(item, Instr)
            and item.name == "LOAD_GLOBAL"
            and isinstance(item.arg, tuple)
            and item.arg[1] == "_spacetimepy_hotswap_injection_boundary"
        ):
            break
        if isinstance(item, Instr):
            argument = item.arg
            if item.name == "LOAD_GLOBAL" and isinstance(argument, tuple):
                if argument[1] == "_spacetimepy_hotswap_entry":
                    argument = (argument[0], _ENTRY_NAME)
                elif argument[1] == "_spacetimepy_hotswap_continue":
                    argument = (argument[0], _CONTINUE_NAME)
            elif argument == "result":
                argument = _TEMPORARY_NAME
            instructions.append(Instr(item.name, argument, lineno=line_number))
        else:
            instructions.append(item)
    return instructions


def hotswappable(function: FunctionType) -> FunctionType:
    """Patch a top-level function with the VS Code hotswap trampoline."""

    if getattr(function, "__spacetimepy_hotswappable__", False):
        return function

    file_path = Path(function.__code__.co_filename).resolve()
    source = _function_source(file_path, function.__name__)
    bytecode = Bytecode.from_code(function.__code__)
    resume_index = next(
        index
        for index, instruction in enumerate(bytecode)
        if isinstance(instruction, Instr) and instruction.name == "RESUME"
    )
    first_instruction = next(
        instruction
        for instruction in bytecode[resume_index + 1 :]
        if isinstance(instruction, Instr) and instruction.lineno is not None
    )
    first_body_line = first_instruction.lineno
    state = _HotSwapState(
        function_name=function.__name__,
        file_path=file_path,
        source=source,
        first_body_line=first_body_line,
        trampoline_line=function.__code__.co_firstlineno,
    )

    def entry() -> object:
        frame = inspect.currentframe()
        target_frame = frame.f_back if frame is not None else None
        del frame
        if target_frame is None:
            return _CONTINUE

        if state.initial_replay_locals is not None:
            saved_locals = state.initial_replay_locals
            state.initial_replay_locals = None
            _restore_locals(target_frame, saved_locals)
            state.replacement_frame = target_frame
            state.saved_locals = saved_locals
            return _CONTINUE

        if state.replacement_source_frame is not None:
            source_frame = state.replacement_source_frame
            saved_locals = dict(source_frame.f_locals)
            _restore_locals(target_frame, saved_locals)
            runtime = get_active_spacetime()
            if runtime is None:
                raise RuntimeError("No active SpaceTimePy recording is available")
            runtime.replay.begin_active_execution(
                source_frame=source_frame,
                replacement_frame=target_frame,
                replacement_target=function,
                # The entry breakpoint runs before the mapped destination.
                # Keep line events filtered until finish() records migrated
                # locals as the first replacement step at that destination.
                replacement_line_numbers=(),
                name="VS Code live hotswap",
                recipe={
                    "integration": "spacetimepy-vscode",
                    "operation": "live-hotswap",
                    "source_line": state.old_line,
                    "target_line": state.target_line,
                },
            )
            state.replacement_frame = target_frame
            state.saved_locals = saved_locals
            state.replacement_source_frame = None
            return _CONTINUE

        if not state.pending:
            return _CONTINUE

        state.pending = False
        module = inspect.getmodule(target_frame)
        if module is None:
            raise RuntimeError("Cannot find the module owning the active function")
        replacement_module = _reload_module(module, state.file_path)
        replacement = getattr(replacement_module, state.function_name)
        if not isinstance(replacement, FunctionType):
            raise TypeError(f"Reloaded {state.function_name!r} is not a Python function")
        replacement = hotswappable(replacement)
        replacement_state: _HotSwapState = replacement.__spacetimepy_hotswap_state__
        replacement_state.replacement_source_frame = target_frame
        replacement_state.old_line = state.old_line
        replacement_state.target_line = state.target_line
        replacement_state.replacement_source = state.replacement_source
        positional, keywords = _call_arguments(replacement, target_frame)
        runtime = get_active_spacetime()
        try:
            result = replacement(*positional, **keywords)
        except BaseException:
            if runtime is not None and runtime.replay._active_context is not None:
                runtime.replay.finish("failed")
            raise
        else:
            if runtime is not None and runtime.replay._active_context is not None:
                runtime.replay.finish()
            return result

    def prepare(line_number: int | None = None) -> dict[str, int]:
        stack = inspect.stack()
        target = next(
            (entry.frame for entry in stack if entry.function == state.function_name),
            None,
        )
        if target is None:
            raise RuntimeError(f"No active {state.function_name} frame was found")
        replacement_source = _function_source(state.file_path, state.function_name)
        old_line = target.f_lineno
        target_line = line_number or _mapped_line(state.source, replacement_source, old_line)
        if not replacement_source.start_line <= target_line <= replacement_source.end_line:
            raise ValueError(
                f"Target line {target_line} is outside {state.function_name}"
            )
        state.pending = True
        state.source_frame = target
        state.old_line = old_line
        state.target_line = target_line
        state.replacement_source = replacement_source
        _bind_unbound_locals(target)
        _set_next_line(state.trampoline_line, state.function_name)
        return {"sourceLine": old_line, "targetLine": target_line}

    def finish() -> dict[str, int]:
        if state.replacement_frame is None or state.saved_locals is None:
            raise RuntimeError("No replacement frame is waiting for state restoration")
        _restore_locals(state.replacement_frame, state.saved_locals)
        _bind_unbound_locals(state.replacement_frame)
        target_line = state.target_line or state.first_body_line
        if not state.replacement_state_recorded:
            runtime = get_active_spacetime()
            if runtime is None:
                raise RuntimeError("No active SpaceTimePy replay is available")
            runtime.replay.record_active_replacement_state(
                frame=state.replacement_frame,
                line_number=target_line,
                replacement_line_numbers=captured_line_numbers(function),
            )
            state.replacement_state_recorded = True
        _set_next_line(target_line, state.function_name)
        return {"targetLine": target_line}

    for instruction in reversed(_injection_instructions(state.trampoline_line)):
        bytecode.insert(resume_index + 1, instruction)
    function.__code__ = bytecode.to_code()
    function.__globals__[_ENTRY_NAME] = entry
    function.__globals__[_CONTINUE_NAME] = _CONTINUE
    function.__globals__[_PREPARE_NAME] = prepare
    function.__globals__[_FINISH_NAME] = finish
    function.__spacetimepy_hotswappable__ = True
    function.__spacetimepy_hotswap_state__ = state
    return function


def prepare_snapshot_replay(
    function: FunctionType,
    *,
    locals: dict[str, Any],
    source_line: int,
    recorded_source: str,
    recorded_first_line: int,
) -> FunctionType:
    """Prepare a newly called function to receive one recorded frame state."""

    function = hotswappable(function)
    state: _HotSwapState = function.__spacetimepy_hotswap_state__
    old_source = _SourceVersion(
        content=recorded_source,
        start_line=recorded_first_line,
        end_line=recorded_first_line + max(0, len(recorded_source.splitlines()) - 1),
    )
    state.target_line = _mapped_line(old_source, state.source, source_line)
    state.old_line = source_line
    state.initial_replay_locals = dict(locals)
    return function


def call_arguments_from_locals(
    function: FunctionType,
    values: dict[str, Any],
) -> tuple[list[Any], dict[str, Any]]:
    """Rebuild a function call from argument names stored in frame locals."""

    positional: list[Any] = []
    keywords: dict[str, Any] = {}
    for parameter in inspect.signature(function).parameters.values():
        if parameter.kind is inspect.Parameter.VAR_POSITIONAL:
            positional.extend(values.get(parameter.name, ()))
        elif parameter.kind is inspect.Parameter.VAR_KEYWORD:
            keywords.update(values.get(parameter.name, {}))
        elif parameter.name in values:
            if parameter.kind is inspect.Parameter.POSITIONAL_ONLY:
                positional.append(values[parameter.name])
            else:
                keywords[parameter.name] = values[parameter.name]
        elif parameter.default is inspect.Parameter.empty:
            raise RuntimeError(
                f"Recorded state does not contain required argument {parameter.name!r}"
            )
    return positional, keywords


def captured_line_numbers(function: FunctionType) -> set[int]:
    """Return user-source lines while excluding the injected trampoline line."""

    state: _HotSwapState = function.__spacetimepy_hotswap_state__
    return set(range(state.first_body_line, state.source.end_line + 1))


__all__ = [
    "call_arguments_from_locals",
    "captured_line_numbers",
    "hotswappable",
    "prepare_snapshot_replay",
]
