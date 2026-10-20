#!/usr/bin/env python3
"""Disposable native binding/delivery probes; inference requires explicit free-route checks."""

import argparse
import base64
import datetime
import hashlib
import json
import os
import pty
import re
import runpy
import secrets
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_LOG = 131072
# The probe records runtime failures in its report instead of crashing the run.
PROBE_ERRORS = (
    OSError,
    RuntimeError,
    ValueError,
    TypeError,
    LookupError,
    AttributeError,
    StopIteration,
    ImportError,
    subprocess.SubprocessError,
    re.error,
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def cleanup_step(report, key, operation):
    try:
        value = operation()
        report["cleanup"][key] = True if value is None else value
    except (
        OSError,
        RuntimeError,
        ValueError,
        TypeError,
        LookupError,
        AttributeError,
        StopIteration,
        ImportError,
    ) as error:
        report["cleanup"][key] = False
        report.setdefault("cleanupFailures", {})[key] = type(error).__name__


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def drain(source, destination):
    written = 0
    with destination.open("wb") as output:
        while True:
            try:
                chunk = os.read(source, 4096)
            except OSError:
                break
            if not chunk:
                break
            allowed = chunk[: max(0, MAX_LOG - written)]
            output.write(allowed)
            written += len(allowed)


def bounded_json_line(process, buffers, timeout=15):
    if process.stdout is None:
        raise RuntimeError("Relay subprocess has no response pipe")
    fd = process.stdout.fileno()
    buffer = buffers.setdefault(fd, bytearray())
    until = time.monotonic() + timeout
    while b"\n" not in buffer:
        remaining = until - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise RuntimeError("Relay subprocess response deadline elapsed")
        chunk = os.read(fd, 4096)
        if not chunk:
            raise RuntimeError("Relay subprocess exited before responding")
        buffer.extend(chunk)
        if len(buffer) > 65536:
            raise RuntimeError("Relay subprocess response exceeded the bound")
    line, _, rest = buffer.partition(b"\n")
    buffers[fd] = bytearray(rest)
    return json.loads(line)


def stop(process):
    if process is None or process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("Owned process did not exit after the kill signal") from error


args = None
binary = None
repo = None
root = None
home = None
project = None
relay = None
opener = None
env = {}
port = 0
address = ""
auth = ""
version = None
report = {}
session = None
prime_id = None
ready_reply = None
nonce = None
delivery_reply = None
permission = None
marker = None
plugin_target = None
observation = {}
schema = None
expected_version = None
model_provider = ""
model_id = ""
model_selection = None
base_config = {}
package_root = None
mapping = None
context_started = False
server = None
native = None
supervisor = None
master = None
logs = []
buffers = {}
tool_probe = False
busy_probe = False
delivery_probe = False
binding_probe = False
held_key = "contextHeld"
expected_delivery_pending = {}


def request(path, method="GET", payload=None, timeout=3):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        address + path,
        data=data,
        method=method,
        headers={"Authorization": "Basic " + auth, "Content-Type": "application/json"},
    )
    with opener.open(req, timeout=timeout) as response:
        raw = response.read(1048577)
        if len(raw) > 1048576:
            raise RuntimeError("Native API response exceeded the bound")
        return json.loads(raw) if raw else None


def unbox(value):
    return value.get("data", value) if isinstance(value, dict) else value


def read_session(session_id):
    value = unbox(request("/api/session/" + session_id))
    if not isinstance(value, dict):
        raise RuntimeError("Native session readback has an invalid shape")
    return value


def read_plugins():
    if not isinstance(schema, dict):
        raise RuntimeError("Native API schema is unavailable")
    paths = [
        path
        for path, methods in schema["paths"].items()
        if methods.get("get", {}).get("operationId") == "plugin.list"
    ]
    require(len(paths) == 1, "Native plugin inventory API is unavailable")
    plugins = unbox(
        request(paths[0] + "?" + urllib.parse.urlencode({"location[directory]": str(project)}))
    )
    if not isinstance(plugins, list):
        raise RuntimeError("Native plugin inventory shape differs")
    return [plugin for plugin in plugins if plugin.get("source", {}).get("type") != "builtin"]


def release_busy():
    control = root / "busy-control"
    if not control.exists():
        return None
    (control / "release").write_text("release\n")
    os.chmod(control / "release", 0o600)
    until = time.monotonic() + 5
    while (control / "ready.json").exists() and not (control / "complete.json").exists():
        if time.monotonic() >= until:
            raise RuntimeError("Controlled native context did not release")
        time.sleep(0.05)
    complete = control / "complete.json"
    return json.loads(complete.read_text()) if complete.exists() else None


def await_tool_completion():
    ready = json.loads((root / "busy-control" / "ready.json").read_text())
    until = time.monotonic() + 5
    while True:
        messages = unbox(request("/api/session/" + session + "/message?limit=20"))
        if not isinstance(messages, list):
            raise RuntimeError("Native tool message readback shape differs")
        tools = [
            part
            for message in messages
            if message.get("type") == "assistant"
            for part in message.get("content", [])
            if part.get("type") == "tool"
        ]
        if (
            len(tools) == 1
            and tools[0].get("name") == "relay_probe_gate"
            and tools[0].get("id") == ready.get("callId")
            and tools[0].get("state", {}).get("status") == "completed"
        ):
            break
        if time.monotonic() >= until:
            raise RuntimeError("Native model-invoked tool did not complete exactly once")
        time.sleep(0.05)
    report["nativeToolCompletion"] = {
        "sameCall": True,
        "status": "completed",
        "callCount": len(tools),
    }
    after = json.loads((root / "busy-control" / "native-after.json").read_text())
    require(
        after.get("status") == "completed"
        and after.get("callId") == ready.get("callId")
        and after.get("resultMatches") is True,
        "Native execution hook did not confirm the exact tool result",
    )


def capture_delivery(session_id):
    try:
        if supervisor is None or supervisor.stdin is None:
            raise RuntimeError("Relay control pipe is unavailable")
        until = time.monotonic() + 2
        while True:
            supervisor.stdin.write(b"status\n")
            supervisor.stdin.flush()
            delivered = bounded_json_line(supervisor, buffers)
            if (
                delivered["attemptStates"] in [["safe_idle"], ["refused"], ["uncertain"]]
                or time.monotonic() >= until
            ):
                break
            time.sleep(0.1)
        report["relayAfterDelivery"] = delivered
        messages = unbox(request("/api/session/" + session_id + "/message?limit=20"))
        if not isinstance(messages, list):
            raise RuntimeError("Native message readback shape differs")
        users = [message for message in messages if message.get("type") == "user"]
        preparation = [message for message in users if message.get("id") == prime_id]
        notices = [message for message in users if message.get("id") != prime_id]
        phases = delivered["attemptPhases"]
        request_id = phases[0].get("nativeRequestId") if len(phases) == 1 else None
        report["promptSubmitted"] = bool(users)
        report["nativeDeliveryReadback"] = {
            "sameSession": read_session(session_id)["id"] == session_id,
            "userMessages": len(users),
            "preparationMessages": len(preparation),
            "noticeMessages": len(notices),
            "admissionMatches": isinstance(request_id, str)
            and any(message.get("id") == request_id for message in users),
            "noticeOnly": bool(notices)
            and all(
                isinstance(message.get("text"), str)
                and message["text"].startswith("Relay pending state changed.")
                and "Isolated native-delivery probe payload" not in message["text"]
                for message in notices
            ),
        }
    except PROBE_ERRORS as error:
        report["evidenceReadbackFailure"] = {
            "type": type(error).__name__,
            "message": str(error)[:200],
        }


def require_current_binding():
    if supervisor is None or supervisor.stdin is None or session is None:
        raise RuntimeError("Native binding control is unavailable")
    supervisor.stdin.write(f"binding {session}\n".encode())
    supervisor.stdin.flush()
    proof = bounded_json_line(supervisor, buffers)
    report["nativeBindingAfterBusy"] = proof
    require(
        proof["activeBindings"] == 1 and proof["exactMapping"] is True,
        "Native binding ended before the pending notice was delivered",
    )


def build_parser():
    parser = argparse.ArgumentParser()
    parser.add_argument("--opencode", required=True, type=Path)
    parser.add_argument(
        "--expect", choices=["rejection", "binding", "delivery"], default="rejection"
    )
    parser.add_argument("--model", default="opencode/ling-3.1-flash-free")
    parser.add_argument("--aperture-url")
    parser.add_argument("--packaged", action="store_true")
    parser.add_argument(
        "--plugin-source",
        choices=["wrapper", "package-root", "export-subpath", "plugin-directory"],
        default="wrapper",
    )
    busy_modes = parser.add_mutually_exclusive_group()
    busy_modes.add_argument("--busy-context", action="store_true")
    busy_modes.add_argument("--busy-tool", action="store_true")
    busy_modes.add_argument("--permission-hold", action="store_true")
    parser.add_argument("--trace-inference", action="store_true")
    return parser


def parse_arguments(parser):
    global args, tool_probe, busy_probe, delivery_probe, binding_probe, held_key
    global expected_version, model_provider, model_id, model_selection
    args = parser.parse_args()
    tool_probe = args.busy_tool or args.permission_hold
    busy_probe = args.busy_context or tool_probe
    held_key = (
        "permissionHeld"
        if args.permission_hold
        else "toolHeld"
        if args.busy_tool
        else "contextHeld"
    )
    if args.trace_inference and (not busy_probe or not args.aperture_url):
        parser.error("Inference tracing requires an isolated busy free-route probe")
    if busy_probe and (
        args.expect != "delivery" or not args.packaged or args.plugin_source != "plugin-directory"
    ):
        parser.error("Native busy checks require direct installed-archive delivery mode")
    if args.plugin_source != "wrapper" and (
        not args.packaged
        or args.expect == "rejection"
        or (args.expect == "delivery" and args.plugin_source != "plugin-directory")
    ):
        parser.error(
            "Direct checks require an installed archive; only plugin-directory supports delivery mode"
        )
    if args.aperture_url:
        url = urllib.parse.urlsplit(args.aperture_url)
        if (
            url.scheme not in ["http", "https"]
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            parser.error("Free inference requires a fixed HTTP(S) endpoint without URL credentials")
        if (
            args.model not in ["free", "openrouter/free", "kilo-auto/free"]
            or args.expect != "delivery"
        ):
            parser.error("Free inference requires delivery mode and an owner-approved free route")
        model_provider, model_id = "relay-free-probe", args.model
        model_selection = {"providerID": model_provider, "model": model_id}
    else:
        model_provider, separator, model_id = args.model.partition("/")
        if (
            separator != "/"
            or model_provider != "opencode"
            or re.fullmatch(r"[A-Za-z0-9._-]{1,128}", model_id) is None
        ):
            parser.error("The probe requires an explicit OpenCode model identifier")
        model_selection = args.model
    delivery_probe = args.expect == "delivery"
    binding_probe = args.expect != "rejection"
    expected_version = "2.0.27" if binding_probe else "2.0.26"


def prepare_paths():
    global binary, repo, root, home, project, relay, opener, marker
    binary = args.opencode.resolve(strict=True)
    repo = Path(__file__).resolve().parents[3]
    root = Path(tempfile.mkdtemp(prefix="relay-native-version-", dir=os.environ["TMPDIR"]))
    home, project, relay = root / "home", root / "project", root / "relay"
    marker = root / "native-setup.json"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def build_report():
    global report
    report = {
        "schemaVersion": 1,
        "capturedAt": datetime.datetime.now(datetime.UTC).isoformat(),
        "question": "Does Relay honor a real native read-permission hold and rejection, then deliver one notice without completing the refused read?"
        if args.permission_hold
        else "Does Relay preserve a model-invoked native tool while message/work hints arrive, then deliver one notice?"
        if args.busy_tool
        else "Does Relay defer message/work hints while the exact native session is busy, then deliver one notice?"
        if args.busy_context
        else "Does a committed Relay notice reach a real model turn in the same idle native session?"
        if delivery_probe
        else "Does the Relay plugin bind from the selected native OpenCode runtime?",
        "expectedOutcome": args.expect,
        "verdict": "INCOMPLETE",
        "qualification": "none; delivery probe incomplete"
        if delivery_probe
        else "none; startup binding only"
        if binding_probe
        else "none; version-boundary experiment only",
        "promptSubmitted": False,
        "pluginSource": args.plugin_source,
        "observationWrapperUsed": args.plugin_source == "wrapper",
        "busyContextProbe": args.busy_context,
        "busyToolProbe": args.busy_tool,
        "permissionHoldProbe": args.permission_hold,
        "inferenceTraceEnabled": args.trace_inference,
        "cleanup": {},
    }


def prepare_workspace():
    global env, version
    for path in [home, project, relay, home / "config" / "opencode"]:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "TMPDIR": str(root),
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "SHELL": "/bin/sh",
        "OPENCODE_SERVER_USERNAME": "opencode",
        "OPENCODE_SERVER_PASSWORD": secrets.token_urlsafe(32),
        "OPENCODE_CONFIG_DIR": str(home / "config" / "opencode"),
        "OPENCODE_DATA_DIR": str(home / "data" / "opencode"),
        "OPENCODE_CACHE_DIR": str(home / "cache" / "opencode"),
        "OPENCODE_STATE_DIR": str(home / "state" / "opencode"),
    }
    for kind in ["CONFIG", "DATA", "CACHE", "STATE"]:
        env[f"XDG_{kind}_HOME"] = str(home / kind.lower())
    version = subprocess.run(
        [str(binary), "--version"],
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    ).stdout.strip()
    with binary.open("rb") as artifact:
        binary_digest = hashlib.file_digest(artifact, "sha256").hexdigest()
    report.update(
        {
            "runtimeVersion": version,
            "runtimeBinarySha256": binary_digest,
            "checkoutRevision": subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip(),
            "checkoutDirty": bool(
                subprocess.check_output(["git", "status", "--porcelain"], cwd=repo)
            ),
            "sourceSha256": {
                name: hashlib.sha256((repo / name).read_bytes()).hexdigest()
                for name in [
                    "package.json",
                    "src/adapters/package.json",
                    "src/adapters/index.mjs",
                    "src/adapters/opencode-plugin-core.mjs",
                    "src/adapters/opencode.mjs",
                    "src/delivery.mjs",
                    "tests/spikes/001-opencode-version-boundary/run.py",
                    "tests/spikes/001-opencode-version-boundary/supervisor.mjs",
                    "tests/spikes/003-opencode-native-delivery/free-provider.mjs",
                    "tests/spikes/004-opencode-direct-loader/idle-observer.mjs",
                ]
            },
        }
    )
    add_conditional_source_digests()
    snapshot_sources()


def add_conditional_source_digests():
    if args.busy_context:
        name = "tests/spikes/005-opencode-busy-boundary/context-gate.mjs"
        report["sourceSha256"][name] = hashlib.sha256((repo / name).read_bytes()).hexdigest()
    if args.busy_tool:
        name = "tests/spikes/007-opencode-tool-boundary/tool-gate.mjs"
        report["sourceSha256"][name] = hashlib.sha256((repo / name).read_bytes()).hexdigest()
    if args.permission_hold:
        name = "tests/spikes/008-opencode-permission-hold/permission-hold.py"
        report["sourceSha256"][name] = hashlib.sha256((repo / name).read_bytes()).hexdigest()
        name = "tests/spikes/008-opencode-permission-hold/permission-tool.mjs"
        report["sourceSha256"][name] = hashlib.sha256((repo / name).read_bytes()).hexdigest()
    if args.trace_inference:
        name = "tests/spikes/006-opencode-inference-path/observer.mjs"
        report["sourceSha256"][name] = hashlib.sha256((repo / name).read_bytes()).hexdigest()


def snapshot_sources():
    for name, digest in report["sourceSha256"].items():
        snapshot = root / "executed-sources" / name
        snapshot.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(repo / name, snapshot)
        os.chmod(snapshot, 0o600)
        require(
            hashlib.sha256(snapshot.read_bytes()).hexdigest() == digest,
            "Executed-source snapshot changed during capture",
        )


def verify_runtime_version():
    if version != f"opencode v{expected_version}":
        raise RuntimeError(f"This {args.expect} probe requires OpenCode {expected_version}")


def reserve_endpoint():
    global auth, port, address
    auth = base64.b64encode(
        f"{env['OPENCODE_SERVER_USERNAME']}:{env['OPENCODE_SERVER_PASSWORD']}".encode()
    ).decode()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    address = f"http://127.0.0.1:{port}"


def build_base_config():
    global base_config, nonce, delivery_reply, prime_id, ready_reply
    base_config = {}
    if not delivery_probe:
        return
    nonce = secrets.token_hex(8)
    delivery_reply = "DELIVERED_" + nonce
    prime_id = "msg_busy_" + nonce if busy_probe else None
    ready_reply = "READY_" + nonce if busy_probe else None
    deny_tools = [{"action": "*", "resource": "*", "effect": "deny"}]
    base_config = {
        "model": model_selection,
        "default_agent": "relay-probe",
        "share": "disabled",
        "update": "disable",
        "permissions": deny_tools,
        "agents": {
            "relay-probe": {
                "model": model_selection,
                "mode": "primary",
                "steps": 2,
                "permissions": deny_tools,
                "request": {"settings": {"maxTokens": 1024, "timeout": 30000}},
                "system": "This is an isolated Relay verification. Never use tools. For a Relay pending notice reply exactly "
                + delivery_reply
                + ".",
            }
        },
    }
    if args.busy_context:
        if not isinstance(ready_reply, str):
            raise RuntimeError("Native preparation challenge is unavailable")
        base_config["agents"]["relay-probe"]["system"] += (
            " For the initial preparation message reply exactly " + ready_reply + "."
        )
    if tool_probe:
        rules = [
            *deny_tools,
            {
                "action": "read" if args.permission_hold else "relay_probe_gate",
                "resource": "*",
                "effect": "ask" if args.permission_hold else "allow",
            },
        ]
        preparation_instruction = (
            "Call the native read tool exactly once for permission-probe.txt. Wait for the native permission result. If rejected, do not retry or bypass it. "
            if args.permission_hold
            else "Call relay_probe_gate exactly once with nonce "
            + nonce
            + ", wait for its result. "
        )
        preparation_reply = (
            "Await the next user message after a rejection."
            if args.permission_hold
            else "Then reply exactly " + str(ready_reply)
        )
        base_config["permissions"] = rules
        base_config["agents"]["relay-probe"].update(
            {
                "permissions": rules,
                "steps": 4,
                "system": "This is an isolated Relay verification. Follow the MOST RECENT user message only. If it begins 'Relay pending state changed.', "
                + "do not call tools and do not repeat the preparation reply; reply exactly "
                + delivery_reply
                + ". Otherwise, for the initial preparation message: "
                + preparation_instruction
                + preparation_reply
                + ". Emit only the required token: no explanation, quotes, markdown, leading or trailing whitespace, or newline.",
            }
        )
    if args.aperture_url:
        req = urllib.request.Request(args.aperture_url.rstrip("/") + "/models")
        with opener.open(req, timeout=20) as response:
            raw = response.read(1048577)
            require(len(raw) <= 1048576, "Free gateway inventory exceeded its bound")
            inventory = json.loads(raw)
        route = next((item for item in inventory["data"] if item.get("id") == model_id), None)
        if not isinstance(route, dict) or "/v1/chat/completions" not in route.get(
            "supported_endpoints", []
        ):
            raise RuntimeError("Selected free route is unavailable or not chat-compatible")
        pricing = route.get("pricing")
        require(
            isinstance(pricing, dict)
            and all(
                type(pricing.get(key)) in [str, int, float]
                and str(pricing[key]) in ["0", "0.0", "0.00000000"]
                for key in ["input", "output"]
            ),
            "Selected gateway route is not explicitly zero-priced",
        )
        report["freeRoute"] = {
            "id": model_id,
            "pricing": route.get("pricing"),
            "endpoint": "owner-approved test-only gateway",
        }
        provider_dir = project / "free-provider"
        provider_dir.mkdir(mode=0o700)
        (provider_dir / "package.json").write_text(
            json.dumps(
                {
                    "name": "relay-isolated-free-provider",
                    "version": "0.0.0",
                    "type": "module",
                    "exports": {".": "./index.mjs"},
                }
            )
        )
        shutil.copyfile(
            repo / "tests/spikes/003-opencode-native-delivery/free-provider.mjs",
            provider_dir / "index.mjs",
        )
        base_config["plugins"] = [
            {
                "package": str(provider_dir),
                "options": {
                    "baseURL": args.aperture_url.rstrip("/"),
                    "route": model_id,
                    "contextTokens": route["context_window_tokens"],
                    "outputTokens": route.get("max_output_tokens", 1024),
                    "tools": tool_probe,
                },
            }
        ]
    (project / "opencode.json").write_text(json.dumps(base_config), encoding="utf-8")


def install_package():
    global package_root
    package_root = None
    if not args.packaged:
        return
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm is unavailable for archive verification")
    artifact_dir = root / "artifact"
    artifact_dir.mkdir(mode=0o700)
    packed = subprocess.run(
        [
            npm,
            "--cache",
            str(root / "npm-cache"),
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            str(artifact_dir),
        ],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    output = json.loads(packed.stdout)
    packages = output if isinstance(output, list) else list(output.values())
    require(
        len(packages) == 1 and packages[0]["name"] == "@pugzui/relay",
        "Archive package identity differs",
    )
    require(
        not any(item["path"].startswith("tests/") for item in packages[0]["files"]),
        "Verification fixtures leaked into the archive",
    )
    archive = artifact_dir / packages[0]["filename"]
    report["packageArchive"] = {
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "entryCount": packages[0]["entryCount"],
        "fixturesExcluded": True,
    }
    subprocess.run(
        [
            npm,
            "--cache",
            str(root / "npm-cache"),
            "install",
            "--offline",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--package-lock=false",
            "--prefix",
            str(project),
            str(archive),
        ],
        cwd=project,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    package_root = project / "node_modules" / "@pugzui" / "relay"


def start_supervisor():
    global supervisor, mapping
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node is unavailable")
    supervisor = subprocess.Popen(
        [
            node,
            str(Path(__file__).with_name("supervisor.mjs")),
            str(relay),
            *([str(package_root)] if package_root else []),
        ],
        cwd=project,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    if supervisor.stderr is None or supervisor.stdin is None:
        raise RuntimeError("Relay subprocess has missing control pipes")
    thread = threading.Thread(
        target=drain, args=(supervisor.stderr.fileno(), root / "relay.log"), daemon=True
    )
    thread.start()
    logs.append(thread)
    mapping = bounded_json_line(supervisor, buffers)


def launch_server(log_name):
    global server
    server = subprocess.Popen(
        [
            str(binary),
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "debug",
            "--print-logs",
        ],
        cwd=project,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    if server.stdout is None:
        raise RuntimeError("Owned native server has no log pipe")
    thread = threading.Thread(
        target=drain, args=(server.stdout.fileno(), root / log_name), daemon=True
    )
    thread.start()
    logs.append(thread)
    until = time.monotonic() + 20
    while True:
        if server.poll() is not None:
            raise RuntimeError("Owned native server exited during startup")
        try:
            request("/openapi.json")
            return
        except urllib.error.HTTPError as error:
            if error.code != 503:
                raise RuntimeError(
                    f"Owned native server readiness returned HTTP {error.code}"
                ) from error
            if time.monotonic() >= until:
                raise RuntimeError(
                    "Owned native server readiness deadline elapsed with HTTP 503"
                ) from error
            responses = report.setdefault("readiness503Responses", {})
            responses[log_name] = responses.get(log_name, 0) + 1
            time.sleep(0.1)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if time.monotonic() >= until:
                raise RuntimeError("Owned native server readiness deadline elapsed") from error
            time.sleep(0.1)


def read_schema():
    global schema
    schema = request("/openapi.json")
    if not isinstance(schema, dict):
        raise RuntimeError("Native API schema shape differs")


def create_session():
    global session
    session_input: dict = {"location": {"directory": str(project)}}
    if delivery_probe:
        model_path = next(
            path
            for path, methods in schema["paths"].items()
            if methods.get("get", {}).get("operationId") == "model.list"
        )
        models = unbox(
            request(
                model_path + "?" + urllib.parse.urlencode({"location[directory]": str(project)})
            )
        )
        if not isinstance(models, list):
            raise RuntimeError("Native model list shape differs")
        model = next(
            (
                item
                for item in models
                if item.get("providerID") == model_provider and item.get("id") == model_id
            ),
            None,
        )
        if (
            not isinstance(model, dict)
            or model.get("enabled") is not True
            or model.get("status") != "active"
        ):
            raise RuntimeError("Explicit free model is unavailable")
        costs = model.get("cost")
        if not args.aperture_url:
            require(
                isinstance(costs, list)
                and bool(costs)
                and all(
                    type(cost.get("input")) in [int, float]
                    and cost["input"] == 0
                    and type(cost.get("output")) in [int, float]
                    and cost["output"] == 0
                    and cost.get("cache", {}).get("read") == 0
                    and cost.get("cache", {}).get("write") == 0
                    for cost in costs
                ),
                "Model is not explicitly zero-priced; paid fallback is forbidden",
            )
        report["model"] = {
            "providerID": model["providerID"],
            "id": model["id"],
            "cost": costs,
        }
        if args.busy_tool:
            require(
                model.get("capabilities", {}).get("tools") is True,
                "Selected native model does not expose tools",
            )
        session_input.update(
            {
                "agent": "relay-probe",
                "model": {"providerID": model_provider, "id": model_id},
            }
        )
    record = unbox(request("/api/session", "POST", session_input))
    if not isinstance(record, dict):
        raise RuntimeError("Native session creation has an invalid shape")
    candidate = record.get("id")
    if (
        not isinstance(candidate, str)
        or re.fullmatch(r"ses_[A-Za-z0-9_-]{1,120}", candidate) is None
    ):
        raise RuntimeError("Native session identity format is invalid")
    session = candidate
    require(
        read_session(session)["id"] == session,
        "Native session readback identity differs",
    )
    require(
        unbox(request("/api/session/" + session + "/message?limit=5")) == [],
        "Native session is not empty",
    )


def write_plugin():
    global plugin_target, base_config, permission
    plugin_dir = project / "probe-plugin"
    plugin_path = plugin_dir / "index.mjs"
    original = (
        "@pugzui/relay/opencode-plugin"
        if args.packaged
        else (repo / "src/adapters/index.mjs").as_uri()
    )
    if args.plugin_source == "wrapper":
        plugin_dir.mkdir(mode=0o700)
        (plugin_dir / "package.json").write_text(
            json.dumps(
                {
                    "name": "relay-version-probe",
                    "version": "0.0.0",
                    "type": "module",
                    "exports": {".": "./index.mjs"},
                }
            ),
            encoding="utf-8",
        )
        plugin_path.write_text(
            'import { writeFile, rename } from "node:fs/promises";\n'
            f"import plugin from {json.dumps(original)};\n"
            'export default { id: "relay-version-probe", async setup(ctx) {\n'
            " const result = await plugin.setup(ctx);\n"
            " let initialIdle = false;\n"
            ' if (typeof result === "function") {\n'
            "  await ctx.session.wait({sessionID: ctx.options.nativeSession}, {signal: AbortSignal.timeout(3000)});\n"
            "  initialIdle = true;\n"
            " }\n"
            f" await writeFile({json.dumps(str(marker) + '.pending')}, JSON.stringify({{\n"
            "  version: ctx.app?.version, optionsPresent: !!ctx.options,\n"
            "  exactSessionConfigured: ctx.options?.nativeSession === "
            + json.dumps(session)
            + ",\n"
            '  nativeMethods: ["get", "prompt", "wait", "hook"].every(key => typeof ctx.session?.[key] === "function"),\n'
            '  cleanupReturned: typeof result === "function", initialIdle\n'
            " }), {mode: 0o600});\n"
            f" await rename({json.dumps(str(marker) + '.pending')}, {json.dumps(str(marker))});\n"
            " return result;\n"
            "} };\n",
            encoding="utf-8",
        )
        plugin_target = str(plugin_dir)
    else:
        if package_root is None:
            raise RuntimeError("Direct loader checks require the installed package root")
        plugin_target = {
            "package-root": str(package_root),
            "export-subpath": "@pugzui/relay/opencode-plugin",
            "plugin-directory": str(package_root / "src" / "adapters"),
        }[args.plugin_source]
        if delivery_probe:
            observer_dir = project / "idle-observer"
            observer_dir.mkdir(mode=0o700)
            (observer_dir / "package.json").write_text(
                json.dumps(
                    {
                        "name": "relay-native-idle-observer",
                        "version": "0.0.0",
                        "type": "module",
                        "exports": {".": "./index.mjs"},
                    }
                ),
                encoding="utf-8",
            )
            shutil.copyfile(
                repo / "tests/spikes/004-opencode-direct-loader/idle-observer.mjs",
                observer_dir / "index.mjs",
            )
            base_config["plugins"] = [
                *base_config.get("plugins", []),
                {
                    "package": str(observer_dir),
                    "options": {
                        "nativeSession": session,
                        "reportPath": str(marker),
                    },
                },
            ]
            if args.busy_context:
                gate_dir = project / "busy-context-gate"
                gate_dir.mkdir(mode=0o700)
                (gate_dir / "package.json").write_text(
                    json.dumps(
                        {
                            "name": "relay-native-context-gate",
                            "version": "0.0.0",
                            "type": "module",
                        }
                    )
                )
                shutil.copyfile(
                    repo / "tests/spikes/005-opencode-busy-boundary/context-gate.mjs",
                    gate_dir / "index.mjs",
                )
                base_config["plugins"].append(
                    {
                        "package": str(gate_dir),
                        "options": {
                            "nativeSession": session,
                            "primeId": prime_id,
                            "controlRoot": str(root / "busy-control"),
                        },
                    }
                )
            if tool_probe:
                (root / "busy-control").mkdir(mode=0o700)
                gate_dir = project / "busy-tool-gate"
                gate_dir.mkdir(mode=0o700)
                (gate_dir / "package.json").write_text(
                    json.dumps(
                        {
                            "name": "relay-native-tool-gate",
                            "version": "0.0.0",
                            "type": "module",
                        }
                    )
                )
                fixture_path = (
                    "tests/spikes/008-opencode-permission-hold/permission-tool.mjs"
                    if args.permission_hold
                    else "tests/spikes/007-opencode-tool-boundary/tool-gate.mjs"
                )
                shutil.copyfile(repo / fixture_path, gate_dir / "index.mjs")
                base_config["plugins"].append(
                    {
                        "package": str(gate_dir),
                        "options": {
                            "nativeSession": session,
                            "nonce": nonce,
                            "controlRoot": str(root / "busy-control"),
                        },
                    }
                )
            if args.permission_hold:
                (project / "permission-probe.txt").write_text(
                    "ISOLATED_PERMISSION_READ_" + str(nonce) + "\n", encoding="utf-8"
                )
                helper = runpy.run_path(
                    str(repo / "tests/spikes/008-opencode-permission-hold/permission-hold.py")
                )["PermissionHold"]
                permission = helper(schema, session, root / "busy-control", request, unbox)
            if args.trace_inference:
                trace_dir = project / "inference-observer"
                trace_dir.mkdir(mode=0o700)
                (trace_dir / "package.json").write_text(
                    json.dumps(
                        {
                            "name": "relay-native-inference-observer",
                            "version": "0.0.0",
                            "type": "module",
                        }
                    )
                )
                shutil.copyfile(
                    repo / "tests/spikes/006-opencode-inference-path/observer.mjs",
                    trace_dir / "index.mjs",
                )
                base_config["plugins"].append(
                    {
                        "package": str(trace_dir),
                        "options": {
                            "nativeSession": session,
                            "reportPath": str(root / "inference-trace.json"),
                            "challenges": [ready_reply, delivery_reply],
                        },
                    }
                )
    config = {
        **base_config,
        "plugins": [
            *base_config.get("plugins", []),
            {
                "package": plugin_target,
                "options": {
                    "relayRoot": str(relay),
                    "profile": "isolated-version-spike",
                    "nativeSession": session,
                    "bindings": [mapping],
                },
            },
        ],
    }
    (project / "opencode.json").write_text(json.dumps(config), encoding="utf-8")
    stop(server)
    launch_server("server.log")
    require(
        read_session(session)["id"] == session,
        "Restart changed the native session identity",
    )


def start_native_client():
    global master, native
    master, slave = pty.openpty()
    try:
        native = subprocess.Popen(
            [str(binary), "mini", "--server", address, "--session", session],
            cwd=project,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
    finally:
        os.close(slave)
    thread = threading.Thread(target=drain, args=(master, root / "native.log"), daemon=True)
    thread.start()
    logs.append(thread)


def observe_native_setup():
    global observation
    until = time.monotonic() + 20
    while not marker.exists():
        if native.poll() is not None or time.monotonic() >= until:
            raise RuntimeError("Native plugin setup was not observed before the deadline")
        time.sleep(0.1)
    observation = json.loads(marker.read_text())
    report["nativeSetup"] = observation
    require(
        observation["version"] == expected_version,
        "Native setup runtime version differs",
    )
    require(
        observation["exactSessionConfigured"] and observation["nativeMethods"],
        "Native setup contract differs",
    )
    require(observation["cleanupReturned"] is binding_probe, "Native setup outcome differs")


def verify_direct_binding():
    until = time.monotonic() + 20
    while True:
        supervisor.stdin.write(f"binding {session}\n".encode())
        supervisor.stdin.flush()
        proof = bounded_json_line(supervisor, buffers)
        report["nativeBindingProof"] = proof
        if proof["activeBindings"] == 1 and proof["exactMapping"] is True:
            break
        if native.poll() is not None or time.monotonic() >= until:
            report["nativePluginInventory"] = read_plugins()
            raise RuntimeError(
                "Direct plugin configuration did not bind the installed Relay plugin"
            )
        time.sleep(0.2)
    until = time.monotonic() + 5
    while True:
        report["nativePluginInventory"] = read_plugins()
        if any(
            plugin.get("id") == "pugzui-relay-delivery"
            and plugin.get("state", {}).get("status") == "active"
            for plugin in report["nativePluginInventory"]
        ):
            break
        if native.poll() is not None or time.monotonic() >= until:
            raise RuntimeError("Native loader did not report the Relay plugin active")
        time.sleep(0.1)


def observe_native_idle():
    global observation
    until = time.monotonic() + 20
    while not marker.exists():
        if native.poll() is not None or time.monotonic() >= until:
            raise RuntimeError("Native idle observation was not recorded before the deadline")
        time.sleep(0.1)
    observation = json.loads(marker.read_text())
    report["nativeIdleObservation"] = observation
    require(
        observation.get("version") == expected_version
        and observation.get("exactSessionConfigured") is True
        and observation.get("initialIdle") is True,
        "Direct native idle observation differs",
    )


def verify_binding():
    if binding_probe:
        supervisor.stdin.write(f"binding {session}\n".encode())
        supervisor.stdin.flush()
        proof = bounded_json_line(supervisor, buffers)
        report["nativeBindingProof"] = proof
        require(
            proof["activeBindings"] == 1 and proof["exactMapping"] is True,
            "Native binding does not match the real Relay session",
        )
    else:
        supervisor.stdin.write(b"enqueue\n")
        supervisor.stdin.flush()
        require(
            bounded_json_line(supervisor, buffers)["queued"] is True,
            "Relay did not enqueue the disposable message",
        )
    supervisor.stdin.write(b"status\n")
    supervisor.stdin.flush()
    status = bounded_json_line(supervisor, buffers)
    report["relay"] = status
    expected_bindings = {"active": 1} if binding_probe else {}
    expected_pending = {"msg": 0, "work": 0} if binding_probe else {"msg": 1, "work": 0}
    require(
        status["status"]["core"]["bindings"] == expected_bindings,
        "Relay binding state differs",
    )
    require(
        status["attemptStates"] == [] and status["pending"] == expected_pending,
        "Relay pending or attempt state differs",
    )
    if binding_probe:
        require(
            status["status"]["clients"][0]["evidence"] == "wired",
            "Native adapter did not report live wiring",
        )
    require(
        read_session(session)["id"] == session,
        "Native session identity changed during the probe",
    )
    require(
        unbox(request("/api/session/" + session + "/message?limit=5")) == [],
        "Native session received an unexpected message",
    )
    report["nativeSessionReadback"] = {"sameSession": True, "messages": 0}


def require_delivery_ready():
    global delivery_reply
    if delivery_reply is None:
        raise RuntimeError("Native reply challenges are unavailable")
    native_session = read_session(session)
    require(
        native_session.get("agent") == "relay-probe"
        and native_session.get("model", {}).get("providerID") == model_provider
        and native_session.get("model", {}).get("id") == model_id,
        "Native agent/model readback differs",
    )
    require(
        observation.get("initialIdle") is True,
        "Native session is not idle before Relay send",
    )
    report["idleBeforeRelaySend"] = not busy_probe


def send_preparation(busy_state):
    global context_started
    (root / "busy-control").mkdir(mode=0o700, exist_ok=True)
    prompt_path = next(
        path
        for path, methods in schema["paths"].items()
        if methods.get("post", {}).get("operationId") == "session.prompt"
    )
    require(
        prompt_path.startswith("/api/") and "{sessionID}" in prompt_path,
        "Native preparation route differs",
    )
    context_started = not args.permission_hold
    request(
        prompt_path.replace("{sessionID}", session),
        "POST",
        {
            "id": prime_id,
            "text": "Prepare the isolated permission probe. Read permission-probe.txt exactly once using the sole native read tool; wait for approval or rejection and never retry. After rejection await the next user message."
            if args.permission_hold
            else (
                "Prepare the isolated busy-boundary probe. Call relay_probe_gate once with nonce "
                + str(nonce)
                + ", wait for its result or native permission rejection, do not retry, then reply exactly "
                + str(ready_reply)
                + "."
            )
            if tool_probe
            else "Prepare the isolated busy-boundary probe. Reply exactly "
            + str(ready_reply)
            + ".",
            "delivery": "queue",
            "resume": True,
        },
    )
    until = time.monotonic() + (60 if tool_probe else 10)
    while True:
        before = busy_state()
        report["nativeBusyBeforeSend"] = before
        if before["nativeActive"] and before[held_key] and before["preparationMessages"] == 1:
            break
        if time.monotonic() >= until:
            raise RuntimeError(
                "Native preparation did not hold the exact session at the requested busy boundary"
            )
        time.sleep(0.1)
    require(
        before["noticeMessages"] == 0 and (tool_probe or before["assistantMessages"] == 0),
        "Native busy probe is not isolated",
    )


def deliver_message():
    supervisor.stdin.write(b"deliver-busy\n" if busy_probe else b"deliver\n")
    supervisor.stdin.flush()
    require(
        bounded_json_line(supervisor, buffers)["queued"] is True,
        "Relay did not commit the native-delivery message",
    )
    report["relayMessageCommitted"] = True


def sample_busy_boundary(busy_state):
    samples = report["busyBoundarySamples"] = []
    until = time.monotonic() + 1
    while True:
        supervisor.stdin.write(b"refresh\n")
        supervisor.stdin.flush()
        held = bounded_json_line(supervisor, buffers)
        native_busy = busy_state()
        samples.append({"native": native_busy, "relay": held})
        require(
            native_busy["nativeActive"]
            and native_busy[held_key]
            and native_busy["preparationMessages"] == 1
            and native_busy["noticeMessages"] == 0
            and (tool_probe or native_busy["assistantMessages"] == 0)
            and held["status"]["core"]["bindings"] == {"active": 1}
            and held["attemptStates"] == []
            and held["pending"] == expected_delivery_pending,
            "Relay submitted before the controlled native busy boundary",
        )
        if time.monotonic() >= until:
            break
        time.sleep(0.1)


def await_safe_idle():
    until = time.monotonic() + 10
    while True:
        supervisor.stdin.write(b"status\n")
        supervisor.stdin.flush()
        delivered = bounded_json_line(supervisor, buffers)
        report["relayAfterDelivery"] = delivered
        if delivered["attemptStates"] == ["safe_idle"]:
            break
        if time.monotonic() >= until:
            raise RuntimeError(
                "Relay did not record native safe idle after the observed model turn"
            )
        time.sleep(0.2)


def verify_delivery_evidence():
    phases = report["relayAfterDelivery"]["attemptPhases"][0]
    require(
        all(
            isinstance(phases.get(key), int)
            for key in ["admittedAt", "contextAt", "turnAt", "safeIdleAt"]
        ),
        "Native delivery phase evidence is incomplete",
    )
    times = [phases[key] for key in ["admittedAt", "contextAt", "turnAt", "safeIdleAt"]]
    require(
        times == sorted(times),
        "Native delivery observations were recorded out of order",
    )
    require(
        all(
            report.get("nativeDeliveryReadback", {}).get(key) is True
            for key in ["sameSession", "admissionMatches", "noticeOnly"]
        ),
        "Native message readback does not match the Relay admission",
    )
    require(
        report["nativeDeliveryReadback"]["userMessages"] == (2 if busy_probe else 1)
        and report["nativeDeliveryReadback"]["noticeMessages"] == 1,
        "Native delivery admitted duplicate notices",
    )
    settled = report["relayAfterDelivery"]
    for _ in range(3):
        supervisor.stdin.write(b"refresh\n")
        supervisor.stdin.flush()
        settled = bounded_json_line(supervisor, buffers)
        require(
            settled["attemptStates"] == ["safe_idle"]
            and settled["pending"] == expected_delivery_pending
            and settled["status"]["core"]["targets"]["locked"] == 0,
            "Unchanged pending state repeated delivery or retained the target gate",
        )
    report["unchangedStateReconciliations"] = 3
    report["relayAfterDelivery"] = settled


def set_delivery_verdict():
    report["qualification"] = (
        "native idle notice/context/turn/safe-idle only; other matrix cases remain unqualified"
    )
    report["verdict"] = (
        "VALIDATED: direct archive-configured Relay plugin reached the same idle native 2.0.27 session and a real model turn"
        if args.plugin_source == "plugin-directory"
        else "VALIDATED: committed Relay notice reached the same idle native 2.0.27 session and a real model turn"
    )
    if args.busy_context:
        report["qualification"] = (
            "native busy-context deferral and real notice/context/turn/safe-idle only; model-tool interruption safety and full D04 remain unqualified"
        )
        report["verdict"] = (
            "VALIDATED: Relay deferred message/work hints while the exact native session was busy, then delivered one notice to a real model turn"
        )
    if args.busy_tool:
        report["qualification"] = (
            "controlled real model-invoked native tool interruption safety and post-tool notice/context/turn/safe-idle only; full D04 and other matrix cases remain unqualified"
        )
        report["verdict"] = (
            "VALIDATED: Relay left a real model-invoked native tool uninterrupted, then delivered one notice after completion"
        )
    if args.permission_hold:
        report["qualification"] = (
            "one native tool-permission hold/rejection and subsequent notice/context/turn/safe-idle only; input-submission refusal, restart recovery and full adapter qualification remain open"
        )
        report["verdict"] = (
            "VALIDATED: Relay honored a real native read-permission hold and rejection, then delivered one notice without completing the refused read"
        )


def run_delivery_probe(busy_state, wait_reply, finish_preparation):
    global expected_delivery_pending
    require_delivery_ready()
    expected_delivery_pending = {"msg": 1, "work": 1 if busy_probe else 0}
    if busy_probe:
        send_preparation(busy_state)
    deliver_message()
    if busy_probe:
        sample_busy_boundary(busy_state)
        finish_preparation()
    try:
        report["deliveryReply"] = wait_reply(
            delivery_reply,
            session,
            after_notice=busy_probe,
            require_binding=require_current_binding if busy_probe else None,
        )
    finally:
        capture_delivery(session)
    await_safe_idle()
    verify_delivery_evidence()
    set_delivery_verdict()


def run_probe(busy_state, wait_reply, finish_preparation):
    prepare_workspace()
    verify_runtime_version()
    reserve_endpoint()
    build_base_config()
    install_package()
    start_supervisor()
    launch_server("bootstrap-server.log")
    read_schema()
    create_session()
    write_plugin()
    start_native_client()
    if args.plugin_source == "wrapper":
        observe_native_setup()
    else:
        verify_direct_binding()
        if delivery_probe:
            observe_native_idle()
    verify_binding()
    if delivery_probe:
        run_delivery_probe(busy_state, wait_reply, finish_preparation)
    else:
        report["verdict"] = (
            f"VALIDATED: native {expected_version} startup binding reaches the live Relay store"
            if binding_probe
            else f"INVALIDATED: plugin rejects unsupported native {expected_version}"
        )


def capture_inference_trace():
    path = root / "inference-trace.json"
    if path.stat().st_size > 65536:
        raise RuntimeError("Inference trace exceeds its bound")
    report["nativeInferenceTrace"] = json.loads(path.read_text())
    require(
        bool(report["nativeInferenceTrace"].get("calls")),
        "No primary inference request was observed",
    )


def delete_session():
    request("/api/session/" + session, "DELETE")
    try:
        request("/api/session/" + session)
        return False
    except urllib.error.HTTPError as error:
        return error.code == 404


def close_relay():
    if supervisor.stdin is None:
        raise RuntimeError("Relay subprocess has no control pipe")
    supervisor.stdin.write(b"stop\n")
    supervisor.stdin.flush()
    closed = bounded_json_line(supervisor, buffers)["closed"]
    supervisor.wait(timeout=10)
    return closed


def finish_cleanup():
    cleanup_step(
        report, "inferenceTraceReadback", capture_inference_trace
    ) if args.trace_inference else None
    cleanup_step(report, "nativeStopped", lambda: stop(native))
    cleanup_step(
        report, "sessionReadbackAbsent", delete_session
    ) if session is not None and server is not None and server.poll() is None else None
    cleanup_step(report, "serverStopped", lambda: stop(server))
    cleanup_step(
        report, "relayClosed", close_relay
    ) if supervisor is not None and supervisor.poll() is None else None
    cleanup_step(report, "supervisorStopped", lambda: stop(supervisor))
    cleanup_step(report, "ptyClosed", lambda: os.close(master)) if master is not None else None
    for thread in logs:
        thread.join(timeout=2)
    cleanup_step(
        report,
        "bridgeArtifacts",
        lambda: [p.name for p in relay.iterdir() if "opencode" in p.name] if relay.exists() else [],
    )
    for path in [home, project, relay]:
        cleanup_step(
            report,
            path.name + "Removed",
            lambda path=path: shutil.rmtree(path) if path.exists() else None,
        )
    report["cleanup"]["privateProfilesRemoved"] = not any(
        p.exists() for p in [home, project, relay]
    )
    report_path = root / "report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    os.chmod(report_path, 0o600)


def record_failure(error):
    report["verdict"] = "INCOMPLETE"
    if report.get("relayMessageCommitted") and isinstance(session, str):
        capture_delivery(session)
    readback = report.get("nativeDeliveryReadback", {})
    phases = report.get("relayAfterDelivery", {}).get("attemptPhases", [])
    if (
        report.get("nativeModelFailure")
        and len(phases) == 1
        and isinstance(phases[0].get("contextAt"), int)
        and all(
            readback.get(key) is True for key in ["sameSession", "admissionMatches", "noticeOnly"]
        )
    ):
        report["verdict"] = (
            "PARTIAL: Relay notice admitted and observed in native context; native turn failed"
        )
    report["failure"] = {"type": type(error).__name__, "message": str(error)[:300]}


def finish_report():
    report_path = root / "report.json"
    print(
        json.dumps(
            {
                "verdict": report["verdict"],
                "runtimeVersion": version,
                "report": str(report_path),
                "cleanup": report["cleanup"],
                "failure": report.get("failure"),
            }
        )
    )
    required_cleanup = [
        "nativeStopped",
        "serverStopped",
        "supervisorStopped",
        "relayClosed",
        "sessionReadbackAbsent",
        "privateProfilesRemoved",
    ]
    required_cleanup.append(
        "toolGateReleased" if args.busy_tool else "contextGateReleased"
    ) if context_started else None
    return (
        0
        if report["verdict"].startswith(("INVALIDATED", "VALIDATED"))
        and all(report["cleanup"].get(key) is True for key in required_cleanup)
        and not report["cleanup"].get("bridgeArtifacts")
        and not report.get("cleanupFailures")
        else 1
    )


def main():
    parse_arguments(build_parser())
    build_report()
    prepare_paths()

    def busy_state():
        def fail(message):
            raise RuntimeError(message)

        fail("Native context probe has no exact session or API schema") if not isinstance(
            schema, dict
        ) or not isinstance(session, str) else None
        active_path = next(
            path
            for path, methods in schema["paths"].items()
            if methods.get("get", {}).get("operationId") == "session.active"
        )
        active = unbox(request(active_path))
        messages = unbox(request("/api/session/" + session + "/message?limit=20"))
        fail("Native busy-context readback differs") if not isinstance(
            active, dict
        ) or not isinstance(messages, list) else None
        control = root / "busy-control"
        ready = (
            json.loads((control / "ready.json").read_text())
            if (control / "ready.json").exists()
            else {}
        )
        tools = [
            (message, part)
            for message in messages
            if message.get("type") == "assistant"
            for part in message.get("content", [])
            if part.get("type") == "tool"
        ]
        matching = [
            (message, part)
            for message, part in tools
            if part.get("name") == "relay_probe_gate"
            and part.get("id") == ready.get("callId")
            and message.get("id") == ready.get("messageId")
        ]
        value = {
            "nativeActive": active.get(session, {}).get("type") == "running",
            "contextHeld": ready.get("version") == expected_version
            and ready.get("sameSession") is True
            and ready.get("primeSeen") is True
            and not (control / "complete.json").exists(),
            "preparationMessages": sum(
                message.get("type") == "user" and message.get("id") == prime_id
                for message in messages
            ),
            "noticeMessages": sum(
                message.get("type") == "user" and message.get("id") != prime_id
                for message in messages
            ),
            "assistantMessages": sum(message.get("type") == "assistant" for message in messages),
        }
        value.update(
            {
                "toolCalls": len(tools),
                "toolHeld": len(tools) == len(matching) == 1
                and all(
                    isinstance(ready.get(key), str) and ready[key]
                    for key in ["callId", "messageId"]
                )
                and ready.get("version") == expected_version
                and ready.get("sameSession") is True
                and matching[0][1].get("state", {}).get("status") == "running"
                and ready.get("agentMatches") is True
                and not (control / "complete.json").exists(),
            }
            if args.busy_tool
            else {}
        )
        value.update(permission.sample(messages) if permission is not None else {})
        return value

    def wait_reply(
        expected,
        session_id,
        after_notice=False,
        require_binding=None,
        allow_tool_steps=False,
    ):
        def fail(message):
            raise RuntimeError(message)

        until = time.monotonic() + 75
        while time.monotonic() < until:
            require_binding() if require_binding is not None else None
            messages = unbox(request("/api/session/" + session_id + "/message?limit=20"))
            fail("Native message list shape differs") if not isinstance(messages, list) else None
            notices = (
                [
                    message
                    for message in messages
                    if message.get("type") == "user"
                    and isinstance(message.get("text"), str)
                    and message["text"].startswith("Relay pending state changed.")
                ]
                if after_notice
                else []
            )
            window = notices[0].get("time", {}).get("created") if len(notices) == 1 else None
            fail("Native reply attribution requires one Relay notice") if after_notice and len(
                notices
            ) > 1 else None
            fail("Native notice timestamp is invalid") if after_notice and len(
                notices
            ) == 1 and type(window) is not int else None
            candidates = [
                message
                for message in messages
                if message.get("type") == "assistant"
                and (
                    not after_notice
                    or (
                        type(window) is int
                        and type(message.get("time", {}).get("created")) is int
                        and message["time"]["created"] >= window
                    )
                )
            ]
            for message in candidates:
                text = "".join(
                    part.get("text", "")
                    for part in message.get("content", [])
                    if part.get("type") == "text"
                )
                tool_step = (
                    allow_tool_steps
                    and message.get("finish") == "tool-calls"
                    and not message.get("error")
                )
                tools = (
                    [part for part in message.get("content", []) if part.get("type") == "tool"]
                    if tool_step
                    else []
                )
                fail(
                    "Native preparation tool step was not the completed isolated gate"
                ) if tool_step and not (
                    len(tools) == 1
                    and tools[0].get("name") == "relay_probe_gate"
                    and tools[0].get("state", {}).get("status") == "completed"
                ) else None
                skipped = tool_step
                if (
                    text == expected
                    and message.get("finish") == "stop"
                    and not message.get("error")
                ):
                    return text
                failed = bool(message.get("error"))
                report.update(
                    {
                        "nativeModelFailure": {
                            key: message["error"].get(key) for key in ["type", "message", "status"]
                        }
                    }
                ) if failed else None
                report.update(
                    {
                        "unexpectedModelReply": {
                            "finish": message.get("finish"),
                            "text": text[:2048],
                        }
                    }
                ) if not failed and message.get("finish") and not skipped else None
                fail(
                    "Native model turn failed: "
                    + str(message["error"].get("message", "unknown failure"))[:200]
                    if failed
                    else "Native model reply did not match the exact challenge"
                ) if failed or (message.get("finish") and not skipped) else None
            time.sleep(0.2)
        fail("Native model reply deadline elapsed")

    def finish_preparation():
        require(
            isinstance(session, str) and isinstance(ready_reply, str),
            "Native preparation has no exact session or reply challenge",
        )
        if permission is not None:
            refusal = report["nativePermissionRefusal"] = permission.reject()
            require(
                refusal.get("turnInterrupted") is True,
                "Native permission refusal did not interrupt its original turn",
            )
            report["nativePreparationTermination"] = refusal
            return
        complete = report["nativeBusyCompletion"] = release_busy()
        require(
            isinstance(complete, dict)
            and complete.get("released") is True
            and complete.get("aborted") is False,
            "Controlled native busy boundary was interrupted or did not complete",
        )
        await_tool_completion() if args.busy_tool else None
        report["preparationReply"] = wait_reply(
            ready_reply, session, allow_tool_steps=args.busy_tool
        )

    try:
        run_probe(busy_state, wait_reply, finish_preparation)
    except PROBE_ERRORS as error:
        record_failure(error)
    finally:
        if context_started:
            cleanup_step(
                report,
                "toolGateReleased" if args.busy_tool else "contextGateReleased",
                lambda: release_busy() is not None,
            )
            cleanup_step(
                report,
                "nativeToolReadback",
                lambda: report.update(
                    {
                        "nativeToolAfterObservation": json.loads(
                            (root / "busy-control" / "native-after.json").read_text()
                        )
                    }
                ),
            ) if args.busy_tool else None
            cleanup_step(
                report,
                "nativeWaitReadback",
                lambda: report.update(
                    {
                        "nativeWaitObservation": json.loads(
                            (root / "busy-control" / "wait-observation.json").read_text()
                        )
                    }
                ),
            ) if args.busy_context else None
        finish_cleanup()
    return finish_report()


if __name__ == "__main__":
    raise SystemExit(main())
