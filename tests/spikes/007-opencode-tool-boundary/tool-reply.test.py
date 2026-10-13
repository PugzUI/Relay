"""Tool-step decoder coverage; not native delivery evidence."""
import ast
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from tempfile import TemporaryDirectory


class ToolReplyTests(unittest.TestCase):
    def test_tool_cleanup_does_not_claim_a_context_wait_observation(self):
        runner = Path(__file__).resolve().parents[1] / "001-opencode-version-boundary" / "run.py"
        module = ast.parse(runner.read_text())
        cleanup = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "cleanup_step")
        main = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        boundary = next(node for node in main.body if isinstance(node, ast.Try)).finalbody[0]
        code = compile(ast.Module(body=[cleanup, boundary], type_ignores=[]), str(runner), "exec")
        with TemporaryDirectory(prefix="relay-tool-cleanup-", dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            (root / "busy-control").mkdir()
            (root / "busy-control" / "native-after.json").write_text(json.dumps({"status": "completed"}))
            report = {"cleanup": {}}
            exec(code, {"context_started": True, "args": SimpleNamespace(busy_tool=True, busy_context=False),
                        "root": root, "json": json, "report": report, "release_busy": lambda: {"released": True}})
            self.assertTrue(report["cleanup"]["nativeToolReadback"])
            self.assertNotIn("nativeWaitReadback", report["cleanup"])

    def test_busy_tool_requires_one_call_with_complete_native_identity(self):
        runner = Path(__file__).resolve().parents[1] / "001-opencode-version-boundary" / "run.py"
        module = ast.parse(runner.read_text())
        main = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        reader = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == "busy_state")
        code = compile(ast.Module(body=[reader], type_ignores=[]), str(runner), "exec")
        identifiers = {"callId": "call_fixture", "messageId": "msg_fixture"}
        cases = [
            ("exact identity", identifiers, {}, False, True),
            ("missing call", {"messageId": "msg_fixture"}, {}, False, False),
            ("missing message", {"callId": "call_fixture"}, {}, False, False),
            ("missing both", {}, {}, False, False),
            ("empty identity", {"callId": "", "messageId": ""}, {}, False, False),
            ("non-string identity", {"callId": 1, "messageId": 2}, {}, False, False),
            ("wrong version", identifiers, {"version": "2.0.26"}, False, False),
            ("wrong session", identifiers, {"sameSession": False}, False, False),
            ("additional call", identifiers, {}, True, False),
        ]
        with TemporaryDirectory(prefix="relay-tool-identity-", dir=os.environ["TMPDIR"]) as directory:
            root = Path(directory)
            (root / "busy-control").mkdir()
            for label, identity, overrides, extra_call, accepted in cases:
                with self.subTest(label=label):
                    ready = {"version": "2.0.27", "sameSession": True, "agentMatches": True,
                             **identity, **overrides}
                    (root / "busy-control" / "ready.json").write_text(json.dumps(ready))
                    tool = {"type": "tool", "name": "relay_probe_gate", "state": {"status": "running"}}
                    if "callId" in identity:
                        tool["id"] = identity["callId"]
                    assistant = {"type": "assistant", "content": [tool]}
                    if "messageId" in identity:
                        assistant["id"] = identity["messageId"]
                    if extra_call:
                        assistant["content"].append({**tool, "id": "call_other_fixture"})
                    messages = [{"type": "user", "id": "msg_preparation"}, assistant]
                    context = {"root": root, "json": json, "session": "ses_fixture", "prime_id": "msg_preparation",
                               "expected_version": "2.0.27", "args": SimpleNamespace(busy_tool=True), "permission": None,
                               "schema": {"paths": {"/active": {"get": {"operationId": "session.active"}}}},
                               "request": lambda path: {"ses_fixture": {"type": "running"}} if path == "/active" else messages,
                               "unbox": lambda value: value}
                    exec(code, context)
                    self.assertEqual(context["busy_state"]()["toolHeld"], accepted)

    def test_only_the_successful_isolated_tool_step_can_precede_the_exact_reply(self):
        runner = Path(__file__).resolve().parents[1] / "001-opencode-version-boundary" / "run.py"
        module = ast.parse(runner.read_text())
        guard = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "require")
        main = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        reader = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == "wait_reply")
        code = compile(ast.Module(body=[guard, reader], type_ignores=[]), str(runner), "exec")
        expected = "READY_FIXTURE"
        cases = [
            ("completed gate", "relay_probe_gate", "completed", expected, True, True),
            ("other tool", "bash", "completed", expected, True, False),
            ("errored gate", "relay_probe_gate", "error", expected, True, False),
            ("ordinary decoder", "relay_probe_gate", "completed", expected, False, False),
            ("padded final reply", "relay_probe_gate", "completed", " " + expected, True, False),
        ]
        for label, name, status, text, allowed, accepted in cases:
            with self.subTest(label=label):
                messages = [
                    {"type": "assistant", "finish": "tool-calls", "content": [{"type": "tool", "name": name, "state": {"status": status}}]},
                    {"type": "assistant", "finish": "stop", "content": [{"type": "text", "text": text}]},
                ]
                ticks = iter([0, 1, 100])
                context = {"time": SimpleNamespace(monotonic=lambda: next(ticks), sleep=lambda _: None),
                           "report": {}, "request": lambda *args: {"data": messages}, "unbox": lambda value: value["data"]}
                exec(code, context)
                if accepted:
                    self.assertEqual(context["wait_reply"](expected, "ses_fixture", allow_tool_steps=allowed), expected)
                else:
                    with self.assertRaises(RuntimeError):
                        context["wait_reply"](expected, "ses_fixture", allow_tool_steps=allowed)


if __name__ == "__main__":
    unittest.main()
