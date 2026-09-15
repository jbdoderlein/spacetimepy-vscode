"""Check captured globals across module reloads and replacement branches."""

from __future__ import annotations

import inspect
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from spacetimepy_vscode_runtime import hotswap
from spacetimepy_vscode_runtime.launch import _load_module

from spacetimepy import ReplayError, SpaceTime, clear_capture_declarations


class TestHotswapGlobals(unittest.TestCase):
    def test_live_and_historical_globals_across_replacements(self):
        for historical in (False, True):
            with (
                self.subTest(historical=historical),
                tempfile.TemporaryDirectory() as directory,
            ):
                clear_capture_declarations()
                path = Path(directory) / "globals_example.py"
                header = """import math as library
counter = 0
items = []
class Definition:
    version = 1
def helper():
    return 1
"""
                original = """def f(x):
    global counter
    counter = counter + 7
    items.append(7)
    hook("prepare")
    return _spacetimepy_hotswap_entry()
"""
                edited = """def f(x):
    global counter
    hook("finish")
    counter += 10
    items.append(counter)
    hook("prepare_again")
    return _spacetimepy_hotswap_entry()
"""
                final = """def f(x):
    hook("finish")
    return counter, items, helper(), Definition.version, library.__name__, x
"""
                path.write_text(header + original)
                module = _load_module(path)
                self.addCleanup(sys.modules.pop, module.__name__, None)
                function = hotswap.hotswappable(module.f)
                contexts = []
                snapshots = []
                retained_live_objects = []
                with SpaceTime.open() as space:

                    def hook(action):
                        frame = inspect.currentframe().f_back
                        if action == "finish":
                            module.__dict__[hotswap._FINISH_NAME]()
                            space.commit()
                            context = space.replay._active_context
                            snapshots.append(
                                space.data.get_branch(context.branch_id).steps[0]
                            )
                            return
                        context = space.replay.prepare_active_execution(
                            source_frame=frame
                        )
                        contexts.append(context)
                        self.assertEqual(
                            context.globals["counter"], 7 if action == "prepare" else 17
                        )
                        self.assertIsNot(context.globals["items"], module.items)
                        retained_live_objects.append(module.items)
                        # Change the live object after capture. Restoration must use stored data.
                        module.items.append(999)
                        if action == "prepare":
                            hotswap._restore_locals(frame, {"x": 9})
                        next_body = edited if action == "prepare" else final
                        next_header = (
                            header.replace("import math", "import json")
                            .replace("= 1", "= 2")
                            .replace("return 1", "return 2")
                        )
                        path.write_text(next_header + next_body)
                        if historical and action == "prepare_again":
                            selected = contexts[0]
                            module.__dict__[hotswap._CHECKPOINT_NAME](
                                selected.parent_branch_id, selected.forked_from_step.id
                            )
                        else:
                            module.__dict__[hotswap._PREPARE_NAME]()

                    module.hook = type("Hook", (), {"__call__": staticmethod(hook)})()
                    captured = space.capture.line(
                        function, lines=hotswap.captured_line_numbers(function)
                    )
                    with (
                        patch.object(hotswap, "_set_next_line"),
                        space.capture.recording(mode="line"),
                    ):
                        result = captured(4)
                    expected_counter = 7 if historical else 17
                    expected_items = [7] if historical else [7, 17]
                    self.assertEqual(
                        result,
                        (
                            expected_counter,
                            expected_items,
                            2,
                            2,
                            "json",
                            4 if historical else 9,
                        ),
                    )
                    self.assertEqual(len(snapshots), 2)
                    self.assertNotEqual(
                        contexts[0].parent_branch_id, contexts[1].parent_branch_id
                    )
                    for index, step in enumerate(snapshots):
                        selected = contexts[0] if historical else contexts[index]
                        branch = space.data.get_branch(step.branch_id)
                        self.assertEqual(
                            branch.parent_branch_id, selected.parent_branch_id
                        )
                        self.assertEqual(
                            branch.forked_from_step_id, selected.forked_from_step.id
                        )
                        self.assertEqual(
                            step.source_step_id, selected.forked_from_step.id
                        )
                        values = space.data.load_references(
                            step.stack_snapshot.global_references
                        )
                        self.assertEqual(
                            values["counter"], 7 if index == 0 else expected_counter
                        )
                        self.assertEqual(
                            values["items"], [7] if index == 0 else expected_items
                        )
                        self.assertEqual(
                            branch.recipe["operation"],
                            "checkpoint-replay"
                            if historical and index == 1
                            else "live-hotswap",
                        )
                    self.assertTrue(
                        all(999 in value for value in retained_live_objects)
                    )
                clear_capture_declarations()

    def test_prepare_failure_does_not_redirect_or_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "failure.py"
            path.write_text("def f(x):\n    return x\n")
            module = _load_module(path)
            self.addCleanup(sys.modules.pop, module.__name__, None)
            function = hotswap.hotswappable(module.f)
            frame = SimpleNamespace(f_code=function.__code__, f_lineno=2)
            state = function.__spacetimepy_hotswap_state__
            for error in (
                ReplayError("No captured step"),
                KeyError("missing stored value"),
            ):
                with (
                    SpaceTime.open() as space,
                    patch.object(
                        hotswap.inspect,
                        "stack",
                        return_value=[SimpleNamespace(frame=frame)],
                    ),
                    patch.object(
                        space.replay, "prepare_active_execution", side_effect=error
                    ),
                    patch.object(hotswap, "_set_next_line") as redirect,
                    patch.object(hotswap, "_reload_module") as reload,
                ):
                    with self.assertRaises(type(error)):
                        module.__dict__[hotswap._PREPARE_NAME]()
                    self.assertFalse(state.pending)
                    self.assertIsNone(state.prepared_globals)
                    redirect.assert_not_called()
                    reload.assert_not_called()

    def test_failed_global_capture_prevents_live_hotswap(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "uncaptured.py"
            path.write_text("def f():\n    return counter\n")
            module = _load_module(path)
            self.addCleanup(sys.modules.pop, module.__name__, None)
            function = hotswap.hotswappable(module.f)
            frame = SimpleNamespace(
                f_code=function.__code__, f_lineno=2, f_globals={"counter": 7}
            )
            snapshot = SimpleNamespace(
                code_definition_id="recorded",
                global_references={},
                attributes={"capture_errors": {"counter": "SerializationError"}},
            )
            context = SimpleNamespace(
                forked_from_step=SimpleNamespace(stack_snapshot=snapshot)
            )
            with (
                SpaceTime.open() as space,
                patch.object(
                    hotswap.inspect,
                    "stack",
                    return_value=[SimpleNamespace(frame=frame)],
                ),
                patch.object(
                    space.replay, "prepare_active_execution", return_value=context
                ),
                patch.object(hotswap, "_set_next_line") as redirect,
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "could not capture globals: counter"
                ):
                    module.__dict__[hotswap._PREPARE_NAME]()
                self.assertFalse(function.__spacetimepy_hotswap_state__.pending)
                redirect.assert_not_called()

    def test_global_restoration_excludes_code_and_runtime_names(self):
        from types import ModuleType

        module = ModuleType("replacement")
        fresh = {
            "library": sys,
            "helper": lambda: 2,
            "Definition": type("New", (), {}),
            "__builtins__": {},
            "_spacetimepy_internal": object(),
        }
        module.__dict__.update(fresh)
        hotswap._restore_globals(
            module,
            {
                "library": inspect,
                "helper": lambda: 1,
                "Definition": type("Old", (), {}),
                "__builtins__": {"old": True},
                "_spacetimepy_internal": "old",
                "counter": 7,
            },
        )
        for name, value in fresh.items():
            self.assertIs(module.__dict__[name], value)
        self.assertEqual(module.counter, 7)
