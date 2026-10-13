"""Reply-decoder regressions only; these do not qualify native delivery."""

import ast
from pathlib import Path
import time
import unittest


class ReplyReaderTests(unittest.TestCase):
    def test_only_the_exact_completed_reply_is_accepted(self):
        runner = Path(__file__).resolve().parents[1] / "001-opencode-version-boundary" / "run.py"
        module = ast.parse(runner.read_text())
        main = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "main")
        reader = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == "wait_reply")
        code = compile(ast.Module(body=[reader], type_ignores=[]), str(runner), "exec")
        expected = "DELIVERED_FIXTURE"
        cases = [
            ("exact", expected, "stop", None, True),
            ("leading whitespace", " " + expected, "stop", None, False),
            ("trailing newline", expected + "\n", "stop", None, False),
            ("quoted challenge", '"' + expected + '"', "stop", None, False),
            ("summary", "Summary: " + expected, "stop", None, False),
            ("truncated", expected, "length", None, False),
            ("errored", expected, "stop", {"type": "provider.auth", "message": "fixture refusal", "status": 403}, False),
        ]
        for label, text, finish, error, accepted in cases:
            with self.subTest(label=label):
                message = {"type": "assistant", "content": [{"type": "text", "text": text}], "finish": finish}
                if error is not None:
                    message["error"] = error
                report = {}
                context = {
                    "time": time,
                    "report": report,
                    "request": lambda *args: {"data": [message]},
                    "unbox": lambda value: value["data"],
                }
                exec(code, context)
                if accepted:
                    self.assertEqual(context["wait_reply"](expected, "ses_fixture"), expected)
                else:
                    with self.assertRaises(RuntimeError):
                        context["wait_reply"](expected, "ses_fixture")
                    if error is None:
                        self.assertEqual(report["unexpectedModelReply"]["text"], text)
                    else:
                        self.assertEqual(report["nativeModelFailure"], error)


if __name__ == "__main__":
    unittest.main()
