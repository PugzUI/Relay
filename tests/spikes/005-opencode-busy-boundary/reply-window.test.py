"""Decoder-only attribution checks; not native receiver evidence."""

import ast
import unittest
from pathlib import Path
from types import SimpleNamespace


class ReplyWindowTests(unittest.TestCase):
    def test_reply_must_belong_to_the_notice_time_window(self):
        runner = Path(__file__).resolve().parents[1] / "001-opencode-version-boundary" / "run.py"
        module = ast.parse(runner.read_text())
        guard = next(
            node
            for node in module.body
            if isinstance(node, ast.FunctionDef) and node.name == "require"
        )
        main = next(
            node
            for node in module.body
            if isinstance(node, ast.FunctionDef) and node.name == "main"
        )
        reader = next(
            node
            for node in main.body
            if isinstance(node, ast.FunctionDef) and node.name == "wait_reply"
        )
        code = compile(ast.Module(body=[guard, reader], type_ignores=[]), str(runner), "exec")
        expected = "DELIVERED_FIXTURE"
        notice = {"type": "user", "text": "Relay pending state changed.", "time": {"created": 2}}

        def reply(text, created):
            return {
                "type": "assistant",
                "content": [{"type": "text", "text": text}],
                "finish": "stop",
                "time": {"created": created},
            }

        cases = [
            ("fresh", [reply(expected, 3), notice], True),
            ("same millisecond", [reply(expected, 2), notice], True),
            ("stale exact", [reply(expected, 1), notice], False),
            ("no notice", [reply(expected, 3)], False),
            ("missing reply timestamp", [reply(expected, None), notice], False),
            (
                "old preparation reply",
                [reply("READY_FIXTURE", 1), reply(expected, 3), notice],
                True,
            ),
        ]
        for label, messages, accepted in cases:
            with self.subTest(label=label):
                ticks = iter([0, 1, 100])
                context = {
                    "time": SimpleNamespace(
                        monotonic=lambda _ticks=ticks: next(_ticks), sleep=lambda _: None
                    ),
                    "report": {},
                    "request": lambda *args, _messages=messages: {"data": _messages},
                    "unbox": lambda value: value["data"],
                }
                exec(code, context)
                if accepted:
                    self.assertEqual(
                        context["wait_reply"](expected, "ses_fixture", after_notice=True), expected
                    )
                else:
                    with self.assertRaises(RuntimeError):
                        context["wait_reply"](expected, "ses_fixture", after_notice=True)


if __name__ == "__main__":
    unittest.main()
