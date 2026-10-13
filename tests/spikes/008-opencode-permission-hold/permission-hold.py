"""Observe and reject one real permission request in an owned native session."""
import json
import re
import time
import urllib.parse


def nonempty_id(value):
    return isinstance(value, str) and 0 < len(value) <= 256


class PermissionHold:
    def __init__(self, schema, session, control, request, unbox):
        if not isinstance(session, str) or re.fullmatch(r"ses_[A-Za-z0-9_-]{1,120}", session) is None:
            raise RuntimeError("Permission probe requires an exact native session")
        expected = {
            "session.permission.list": ("get", "/api/session/{sessionID}/permission"),
            "session.permission.reply": ("post", "/api/session/{sessionID}/permission/{requestID}/reply"),
        }
        for operation, (method, path) in expected.items():
            found = [candidate for candidate, methods in schema.get("paths", {}).items()
                     if methods.get(method, {}).get("operationId") == operation]
            if found != [path]:
                raise RuntimeError("Native permission API contract differs")
        self.session, self.control = session, control
        self.request, self.unbox = request, unbox
        self.path = "/api/session/" + session + "/permission"
        self.identity = None

    def pending(self):
        values = self.unbox(self.request(self.path))
        if not isinstance(values, list) or len(values) > 64 or not all(isinstance(value, dict) for value in values):
            raise RuntimeError("Native permission list exceeded its shape or bound")
        return values

    def identity_for(self, value):
        source = value.get("source")
        if (value.get("sessionID") != self.session or value.get("action") != "read"
                or not nonempty_id(value.get("id")) or not value["id"].startswith("per")
                or not isinstance(source, dict) or source.get("type") != "tool"
                or not all(nonempty_id(source.get(key)) for key in ["id", "messageID"])):
            return None
        return value["id"], source["id"], source["messageID"]

    def tool_records(self, messages):
        if not isinstance(messages, list) or len(messages) > 20:
            raise RuntimeError("Native permission tool readback differs")
        return [(message, part) for message in messages if message.get("type") == "assistant"
                for part in message.get("content", []) if part.get("type") == "tool"]

    def operation_completed(self):
        path = self.control / "native-after.json"
        if not path.exists():
            return False
        if path.stat().st_size > 4096:
            raise RuntimeError("Native read observation exceeded its bound")
        return json.loads(path.read_text()).get("status") == "completed"

    def sample(self, messages):
        pending, tools = self.pending(), self.tool_records(messages)
        identity = self.identity_for(pending[0]) if len(pending) == 1 else None
        matching = [(message, part) for message, part in tools if identity
                    and message.get("id") == identity[2] and part.get("id") == identity[1]
                    and part.get("name") == "read" and part.get("state", {}).get("status") == "running"]
        completed = self.operation_completed()
        held = len(tools) == len(matching) == 1 and not completed
        if held:
            if self.identity is not None and self.identity != identity:
                raise RuntimeError("Native permission identity changed during the hold")
            self.identity = identity
        return {"permissionHeld": held, "permissionRequests": len(pending), "toolCalls": len(tools),
                "operationCompleted": completed}

    def reject(self):
        if self.identity is None or self.operation_completed():
            raise RuntimeError("Native permission rejection has no held exact target")
        pending = self.pending()
        if len(pending) != 1 or self.identity_for(pending[0]) != self.identity:
            raise RuntimeError("Native permission changed before rejection")
        request_id, call_id, message_id = self.identity
        self.request(self.path + "/" + urllib.parse.quote(request_id, safe="") + "/reply", "POST", {"decision": "reject"})
        until = time.monotonic() + 5
        while True:
            pending = self.pending()
            messages = self.unbox(self.request("/api/session/" + self.session + "/message?limit=20"))
            tools = self.tool_records(messages)
            matching = [(message, part) for message, part in tools if message.get("id") == message_id
                        and part.get("id") == call_id and part.get("name") == "read"
                        and part.get("state", {}).get("status") == "error"]
            if self.operation_completed():
                raise RuntimeError("Native permission rejection was bypassed by a completed read")
            if not pending and len(tools) == len(matching) == 1:
                error = matching[0][1].get("state", {}).get("error")
                error_type = error.get("type") if isinstance(error, dict) else None
                turn_error = matching[0][0].get("error")
                return {"decision": "reject", "pendingReadbackAbsent": True, "sameCall": True,
                        "toolState": "error", "operationCompleted": False,
                        "turnInterrupted": isinstance(turn_error, dict) and turn_error.get("type") == "aborted",
                        "errorType": error_type if isinstance(error_type, str) and len(error_type) <= 128 else None}
            if time.monotonic() >= until:
                raise RuntimeError("Native permission rejection did not settle the exact tool")
            time.sleep(0.05)
