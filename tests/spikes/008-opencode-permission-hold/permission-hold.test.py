"""Permission-observer regressions, not native hold/refusal evidence."""
import ast
import copy
import json
import os
from pathlib import Path
import runpy
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest


class PermissionHoldTests(unittest.TestCase):
    def fixture(self):
        helper = runpy.run_path(str(Path(__file__).with_name("permission-hold.py")))["PermissionHold"]
        directory = TemporaryDirectory(prefix="relay-permission-fixture-", dir=os.environ["TMPDIR"])
        self.addCleanup(directory.cleanup)
        control = Path(directory.name)
        pending = [{"id": "per_fixture", "sessionID": "ses_fixture", "action": "read",
                    "source": {"type": "tool", "id": "call_fixture", "messageID": "msg_fixture"}}]
        messages = [{"type": "assistant", "id": "msg_fixture", "content": [
            {"type": "tool", "id": "call_fixture", "name": "read", "state": {"status": "running"}}]}]
        calls = []
        def request(path, method="GET", payload=None):
            calls.append((path, method, payload))
            if method == "POST":
                pending.clear()
                messages[0]["content"][0]["state"] = {"status": "error", "error": {"type": "permission.rejected"}}
                messages[0]["error"] = {"type": "aborted", "message": "Step interrupted"}
                return None
            return {"data": messages if "/message?" in path else pending}
        schema = {"paths": {
            "/api/session/{sessionID}/permission": {"get": {"operationId": "session.permission.list"}},
            "/api/session/{sessionID}/permission/{requestID}/reply": {"post": {"operationId": "session.permission.reply"}},
        }}
        observer = helper(schema, "ses_fixture", control, request, lambda value: value["data"])
        return observer, pending, messages, calls, control

    def test_hold_matches_native_permission_to_the_waiting_read(self):
        observer, pending, messages, calls, control = self.fixture()
        sample = observer.sample(messages)
        self.assertTrue(sample["permissionHeld"])
        self.assertFalse(sample["operationCompleted"])
        self.assertEqual(sample["toolCalls"], 1)
        self.assertEqual(sample["permissionRequests"], 1)

    def test_rejection_uses_native_decision_and_exact_session_with_readback(self):
        observer, pending, messages, calls, control = self.fixture()
        observer.sample(messages)
        result = observer.reject()
        self.assertEqual([call for call in calls if call[1] == "POST"], [
            ("/api/session/ses_fixture/permission/per_fixture/reply", "POST", {"decision": "reject"})])
        self.assertTrue(result["pendingReadbackAbsent"])
        self.assertTrue(result["sameCall"])
        self.assertTrue(result["turnInterrupted"])
        self.assertEqual(result["toolState"], "error")
        self.assertFalse(result["operationCompleted"])

    def test_incomplete_or_ambiguous_source_cannot_establish_a_hold(self):
        for label in ["missing call", "missing message", "empty call", "duplicate permission", "extra tool"]:
            with self.subTest(label=label):
                observer, pending, messages, calls, control = self.fixture()
                if label == "missing call":
                    pending[0]["source"].pop("id")
                    messages[0]["content"][0].pop("id")
                elif label == "missing message":
                    pending[0]["source"].pop("messageID")
                    messages[0].pop("id")
                elif label == "empty call":
                    pending[0]["source"]["id"] = messages[0]["content"][0]["id"] = ""
                elif label == "duplicate permission":
                    pending.append(copy.deepcopy(pending[0]))
                else:
                    messages[0]["content"].append({**messages[0]["content"][0], "id": "call_other"})
                self.assertFalse(observer.sample(messages)["permissionHeld"])
                self.assertFalse(any(call[1] == "POST" for call in calls))

    def test_rejection_revalidates_owner_and_source_before_writing(self):
        for field, value in [("sessionID", "ses_other"), ("action", "bash"), ("id", "per_other")]:
            with self.subTest(field=field):
                observer, pending, messages, calls, control = self.fixture()
                observer.sample(messages)
                pending[0][field] = value
                with self.assertRaises(RuntimeError):
                    observer.reject()
                self.assertFalse(any(call[1] == "POST" for call in calls))

    def test_completed_read_cannot_pass_native_refusal(self):
        observer, pending, messages, calls, control = self.fixture()
        observer.sample(messages)
        (control / "native-after.json").write_text(json.dumps({"status": "completed"}))
        with self.assertRaises(RuntimeError):
            observer.reject()
        self.assertFalse(any(call[1] == "POST" for call in calls))

    def test_unobserved_permission_is_not_execution_authority(self):
        observer, pending, messages, calls, control = self.fixture()
        with self.assertRaises(RuntimeError):
            observer.reject()
        self.assertFalse(any(call[1] == "POST" for call in calls))

    def test_native_refusal_requires_the_observed_interruption_not_a_generated_reply(self):
        runner = Path(__file__).resolve().parents[1] / "001-opencode-version-boundary" / "run.py"
        module = ast.parse(runner.read_text())
        guard = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "require")
        main = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        reader = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == "finish_preparation")
        code = compile(ast.Module(body=[guard, reader], type_ignores=[]), str(runner), "exec")
        for interrupted in [True, False]:
            with self.subTest(interrupted=interrupted):
                refusal = {"turnInterrupted": interrupted, "sameCall": True, "toolState": "error", "operationCompleted": False}
                context = {"session": "ses_fixture", "ready_reply": "READY_FIXTURE", "report": {},
                           "permission": SimpleNamespace(reject=lambda: refusal)}
                exec(code, context)
                if interrupted:
                    context["finish_preparation"]()
                    self.assertTrue(context["report"]["nativePreparationTermination"]["turnInterrupted"])
                    self.assertNotIn("preparationReply", context["report"])
                else:
                    with self.assertRaises(RuntimeError):
                        context["finish_preparation"]()


if __name__ == "__main__":
    unittest.main()
