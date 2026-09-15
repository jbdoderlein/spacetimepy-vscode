"""Check shared source-line mapping for debugger replacement paths."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from spacetimepy import CodeDiffLineMapper
from spacetimepy_vscode_runtime import hotswap


class TestHotswapMapping(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "example.py"

    def source(self, content: str, start: int = 1) -> hotswap._SourceVersion:
        return hotswap._SourceVersion(
            content, start, start + len(content.splitlines()) - 1
        )

    def function(self, source: hotswap._SourceVersion):
        text = "\n" * (source.start_line - 1) + source.content
        self.path.write_text(text, encoding="utf-8")
        namespace = {}
        exec(compile(text, str(self.path), "exec"), namespace)
        return namespace["f"]

    def test_shared_mapping_examples(self) -> None:
        original = "def f(left, right):\n    result = left + right\n    return result\n"
        for content, expected in (
            (original, 21),
            (
                "def f(left, right):\n    print(left)\n    result = left + right\n    return result\n",
                22,
            ),
            ("def f(left, right):\n    result = left - right\n    return result\n", 21),
            (
                "def f(left, right):\n    result = (\n        left\n        + right\n    )\n    return result\n",
                21,
            ),
        ):
            with self.subTest(content=content):
                old = self.source(original, 10)
                new = self.source(content, 20)
                shared = CodeDiffLineMapper().compare(
                    hotswap._code_definition(old), hotswap._code_definition(new)
                )
                self.assertEqual(
                    next(
                        p.target_line
                        for p in shared.correspondences
                        if p.reference_line == 11
                    ),
                    expected,
                )
                self.assertEqual(hotswap._mapped_line(old, new, 11), expected)

    def test_all_paths_use_shared_provider_with_correct_versions(self) -> None:
        cases = (
            (
                "def f(left, right):\n    result = left + right\n    return result\n",
                "def f(left, right):\n    result = (\n        left\n        + right\n    )\n    return result\n",
                11,
            ),
            (
                "def f(left, right):\n    result = left + right\n    print(result)\n    return result\n",
                "def f(left, right):\n    result = left + right\n    return result\n",
                12,
            ),
        )
        for old_content, new_content, source_line in cases:
            recorded = self.source(old_content, 10)
            edited = self.source(new_content, 20)
            for mode in ("direct", "checkpoint", "snapshot"):
                with self.subTest(mode=mode, source_line=source_line):
                    # The active function differs from the selected checkpoint.
                    active = (
                        recorded
                        if mode == "direct"
                        else self.source("def f(left, right):\n    return left\n", 30)
                    )
                    function = self.function(active if mode != "snapshot" else edited)
                    if mode != "snapshot":
                        hotswap.hotswappable(function)
                        self.path.write_text(
                            "\n" * 19 + edited.content, encoding="utf-8"
                        )
                    frame = SimpleNamespace(f_lineno=source_line, f_locals={}, f_code=function.__code__)
                    runtime = Mock()
                    runtime.replay.active_session_id = 7
                    runtime.replay.prepare.return_value = SimpleNamespace(
                        session_id=7,
                        locals={"left": 1, "right": 2},
                        globals={},
                        forked_from_step=SimpleNamespace(
                            stack_snapshot=SimpleNamespace(
                                code_definition_id="recorded",
                                function_call_id=1,
                                line_number=source_line,
                            )
                        ),
                    )
                    runtime.replay.prepare_active_execution.return_value = SimpleNamespace(
                        globals={}, parent_branch_id=2,
                        forked_from_step=SimpleNamespace(id=3, stack_snapshot=SimpleNamespace(code_definition_id="recorded", attributes={})),
                    )
                    runtime.data.get_function_call.return_value = SimpleNamespace(
                        function_name="f"
                    )
                    runtime.data.get_code_definition.return_value = (
                        hotswap._code_definition(recorded)
                    )
                    with (
                        patch.object(
                            hotswap.inspect,
                            "stack",
                            return_value=[SimpleNamespace(function="f", frame=frame)],
                        ),
                        patch.object(
                            hotswap, "get_active_spacetime", return_value=runtime
                        ),
                        patch.object(hotswap, "_bind_unbound_locals"),
                        patch.object(hotswap, "_set_next_line"),
                        patch.object(
                            hotswap.CodeDiffLineMapper,
                            "compare",
                            wraps=CodeDiffLineMapper().compare,
                        ) as compare,
                    ):
                        if mode == "direct":
                            result = function.__globals__[hotswap._PREPARE_NAME]()
                        elif mode == "checkpoint":
                            result = function.__globals__[hotswap._CHECKPOINT_NAME](
                                2, 3
                            )
                        else:
                            hotswap.prepare_snapshot_replay(
                                function,
                                locals={"left": 1, "right": 2},
                                source_line=source_line,
                                recorded_source=recorded.content,
                                recorded_first_line=10,
                            )
                            result = {
                                "targetLine": function.__spacetimepy_hotswap_state__.target_line
                            }
                    self.assertEqual(result["targetLine"], 21)
                    compare.assert_called_once()
                    reference, target = compare.call_args.args
                    self.assertEqual(
                        reference.code_content,
                        recorded.content.rstrip("\n")
                        if mode == "direct"
                        else recorded.content,
                    )
                    self.assertEqual(reference.first_line_number, 10)
                    self.assertEqual(target.code_content, edited.content.rstrip("\n"))
                    self.assertEqual(target.first_line_number, 20)
                    runtime.replay.begin.assert_not_called()
                    runtime.replay.begin_active_execution.assert_not_called()

    def test_explicit_destination_bypasses_automatic_mapping(self) -> None:
        function = hotswap.hotswappable(
            self.function(self.source("def f(x):\n    return x\n"))
        )
        frame = SimpleNamespace(f_lineno=2, f_locals={}, f_code=function.__code__)
        runtime = Mock()
        runtime.replay.prepare_active_execution.return_value = SimpleNamespace(
            globals={}, parent_branch_id=2,
            forked_from_step=SimpleNamespace(id=3, stack_snapshot=SimpleNamespace(code_definition_id="recorded", attributes={})),
        )
        with (
            patch.object(hotswap, "get_active_spacetime", return_value=runtime),
            patch.object(
                hotswap.inspect,
                "stack",
                return_value=[SimpleNamespace(function="f", frame=frame)],
            ),
            patch.object(hotswap, "_bind_unbound_locals"),
            patch.object(hotswap, "_set_next_line") as redirect,
            patch.object(hotswap.CodeDiffLineMapper, "compare") as compare,
        ):
            prepare = function.__globals__[hotswap._PREPARE_NAME]
            self.assertEqual(prepare(2)["targetLine"], 2)
            with self.assertRaisesRegex(ValueError, "outside"):
                prepare(0)
            compare.assert_not_called()
            redirect.assert_called_once()

    def test_unmapped_line_uses_nearest_preceding_source_correspondence(self) -> None:
        old = self.source(
            "def f(x):\n    value = x + 1\n    print(value)\n    return value\n", 10
        )
        new = self.source("def f(x):\n    value = x + 1\n    return value\n", 20)
        self.assertEqual(hotswap._mapped_line(old, new, 12), 21)
        self.assertEqual(hotswap._mapped_line(old, new, 13), 22)
        with self.assertRaisesRegex(ValueError, "no correspondence at or before"):
            hotswap._mapped_line(old, new, 9)

    def test_failed_live_mapping_does_not_change_paused_state(self) -> None:
        for checkpoint in (False, True):
            with self.subTest(checkpoint=checkpoint):
                function = hotswap.hotswappable(
                    self.function(self.source("def f(x):\n    return x\n"))
                )
                state = function.__spacetimepy_hotswap_state__
                original_state = vars(state).copy()
                frame = SimpleNamespace(f_lineno=0, f_locals={}, f_code=function.__code__)
                runtime = Mock()
                runtime.replay.active_session_id = 7
                runtime.replay.prepare.return_value = SimpleNamespace(
                    session_id=7,
                    locals={},
                    globals={},
                    forked_from_step=SimpleNamespace(
                        stack_snapshot=SimpleNamespace(
                            code_definition_id="recorded",
                            function_call_id=1,
                            line_number=0,
                        )
                    ),
                )
                runtime.data.get_function_call.return_value = SimpleNamespace(
                    function_name="f"
                )
                runtime.data.get_code_definition.return_value = (
                    hotswap._code_definition(state.source)
                )
                with (
                    patch.object(
                        hotswap.inspect,
                        "stack",
                        return_value=[SimpleNamespace(function="f", frame=frame)],
                    ),
                    patch.object(hotswap, "get_active_spacetime", return_value=runtime),
                    patch.object(hotswap, "_bind_unbound_locals") as bind,
                    patch.object(hotswap, "_set_next_line") as redirect,
                ):
                    with self.assertRaisesRegex(
                        ValueError, "Automatic hotswap is unavailable"
                    ):
                        if checkpoint:
                            function.__globals__[hotswap._CHECKPOINT_NAME](2, 3)
                        else:
                            function.__globals__[hotswap._PREPARE_NAME]()
                self.assertEqual(vars(state), original_state)
                bind.assert_not_called()
                redirect.assert_not_called()
                runtime.replay.begin.assert_not_called()
                runtime.replay.begin_active_execution.assert_not_called()

    def test_failed_snapshot_mapping_does_not_patch_function(self) -> None:
        source = self.source("def f(x):\n    return x\n")
        function = self.function(source)
        original_code = function.__code__
        with self.assertRaisesRegex(ValueError, "Automatic hotswap is unavailable"):
            hotswap.prepare_snapshot_replay(
                function,
                locals={"x": 1},
                source_line=0,
                recorded_source=source.content,
                recorded_first_line=1,
            )
        self.assertIs(function.__code__, original_code)
        self.assertFalse(hasattr(function, "__spacetimepy_hotswap_state__"))

    def test_new_session_validates_mapping_before_branch_creation(self) -> None:
        from spacetimepy_vscode_runtime import replay

        source = self.source("def f(x):\n    return x\n")
        function = self.function(source)
        module = SimpleNamespace(f=function)
        space = Mock()
        space.replay.prepare.return_value = SimpleNamespace(
            locals={"x": 1},
            globals={},
            forked_from_step=SimpleNamespace(
                stack_snapshot=SimpleNamespace(
                    code_definition_id="recorded",
                    line_number=0,
                )
            ),
        )
        space.data.get_code_definition.return_value = hotswap._code_definition(source)
        with (
            patch.object(replay.SpaceTime, "open") as opened,
            patch.object(replay, "_load_module", return_value=module),
            patch.object(replay, "_restore_globals") as restore,
            patch.object(replay, "_call") as call,
            patch(
                "sys.argv",
                [
                    "replay",
                    "--database",
                    "unused.db",
                    "--target-file",
                    str(self.path),
                    "--function",
                    "f",
                    "--parent-branch",
                    "2",
                    "--forked-from-step",
                    "3",
                    "--launch-id",
                    "test",
                ],
            ),
        ):
            opened.return_value.__enter__.return_value = space
            with self.assertRaisesRegex(ValueError, "Automatic hotswap is unavailable"):
                replay.main()
        space.replay.prepare.assert_called_once_with(
            parent_branch_id=2, forked_from_step_id=3
        )
        space.replay.begin.assert_not_called()
        space.capture.line.assert_not_called()
        restore.assert_not_called()
        call.assert_not_called()
