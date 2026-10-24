"""Fixture integration tests; never read real Branchline histories."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


CLIENT = Path(__file__).with_name("branchline-client.py")


class BranchlineClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                url = urlsplit(self.path)
                query = parse_qs(url.query)
                cls.requests.append((url.path, query))
                if url.path == "/redirect/session-catalog":
                    self.send_response(302)
                    self.send_header("Location", "/session-catalog")
                    self.end_headers()
                    return
                if url.path == "/empty/events":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    return
                if url.path in ("/malformed/session-events", "/malformed/session-cost-history"):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"history":null,"events":[null]}')
                    return
                if url.path == "/broken/session-catalog":
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"<html>not JSON</html>")
                    return
                if url.path == "/events":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    tracked = {"type": "session-list", "sessions": [
                        {"id": "saved", "label": "Current native name ☃", "status": "active", "runtime": "codex", "startTime": 150, "lastActivityTime": 200},
                        {"id": "review", "label": "Review", "status": "active", "kind": "review"},
                    ]}
                    self.wfile.write((": heartbeat\n\ndata: " + json.dumps(tracked) + "\n\n").encode())
                    return
                if url.path == "/session-catalog":
                    data = {"sessions": [
                        {"id": "saved", "label": "Saved label ☃", "status": "completed", "historical": True, "runtime": "codex", "provider": "openai", "startTime": 10, "lastActivityTime": 300},
                        {"id": "other", "label": "Other", "status": "completed", "runtime": "claude", "provider": "anthropic", "lastActivityTime": 250},
                    ]}
                elif url.path == "/session-cost-history":
                    if query.get("sessionId") == ["missing"]:
                        self.send_response(404)
                        self.end_headers()
                        self.wfile.write(b'{"error":"Cost history is unavailable"}')
                        return
                    data = {"sessionId": 'other-session' if query.get('sessionId') == ['wrong-session'] else query["sessionId"][0], "history": {
                        "totalCostUSD": None, "unpricedResponses": 1, "untimedCostUSD": 0.25,
                        "range": query.get("range", ["total"])[0], "groupBy": "model" if query.get("sessionId") == ["legacy"] else query.get("groupBy", ["model"])[0],
                        "window": {"start": 100, "end": 200, "startCostUSD": 0.5},
                        "groups": [
                            {"id": '["agent","child / ☃"]', "agentId": "child / ☃", "agentName": "Saved child", "records": 2, "totalTokens": 25, "tokens": {"inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 10, "cacheWriteTokens": 0}, "costUSD": None, "knownCostUSD": 0.75, "cacheWritesUnknown": True, "averageCostUSDPerMinute": None, "breakdownUSD": {"input": 0.1, "output": 0.5, "cacheRead": 0.15, "cacheWrite": 0, "unattributed": 0}},
                            {"id": '["agent",null]', "records": 1, "costUSD": 0.25, "knownCostUSD": 0.25},
                        ],
                        "points": [{"timestamp": i, "costUSD": i / 10} for i in range(5)],
                        "burnRate": {"bucketMs": 60000, "points": [{"timestamp": i, "costUSDPerMinute": i / 10} for i in range(5)]},
                        "cacheReuse": {"agents": [{"id": "child / ☃"}]},
                    }}
                    if query.get('sessionId') != ['ignored-group']:
                        data['history']['group'] = query.get('group', [None])[0]
                    if query.get('fixedWindow') == ['true'] and query.get('groupBy') == ['agent']:
                        del data['history']['groups']
                elif url.path == "/session-events":
                    data = {"streamId": "stream", "throughEventId": 4, "events": [
                        {"eventId": 1, "streamId": "stream", "time": 0, "type": "agent_spawn", "payload": {"name": "child / ☃", "parent": "main", "task": "private task", "model": "claude-sonnet-5-5", "reasoningEffort": "high"}},
                        {"eventId": 2, "streamId": "stream", "time": 1, "type": "message", "payload": {"agent": "child / ☃", "role": "assistant", "content": "private message"}},
                        {"eventId": 3, "streamId": "stream", "time": 2, "type": "tool_call_start", "payload": {"agent": "child / ☃", "tool": "exec", "args": "private args", "inputData": {"secret": "private input"}}},
                        {"eventId": 4, "streamId": "stream", "time": 3, "type": "agent_complete", "payload": {"name": "other"}},
                    ]}
                    if query.get('sessionId') == ['context-session']:
                        data['events'] = [{'eventId': 1, 'streamId': 'stream', 'time': 0, 'type': 'context_update', 'payload': {
                            'agent': 'main', 'tokens': 123, 'usage': {'inputTokens': 10, 'outputTokens': 5, 'cacheReadTokens': 20,
                            'cacheWriteTokens': 0, 'cacheWrite1hTokens': 0, 'reasoningTokens': 2, 'totalTokens': 35, 'costUSD': .5},
                            'breakdown': {'systemPrompt': 12, 'userMessages': 111}}}]
                elif url.path == "/spend-overview":
                    data = {"status": {"state": "indexing", "processed": 1, "total": 2, "indexed": 1}, "window": {"start": None, "end": 200}, "totals": {"knownCostUSD": 1, "unpricedResponses": 1, "untimedResponses": 1, "tokens": {"cacheWriteTokens": 0}}, "days": [{"day": "2026-10-24", "knownCostUSD": 1}], "sessions": [{"session": {"id": "saved", "label": "Saved label ☃"}, "knownCostUSD": 1, "indexed": True, "stale": True}], "providers": [], "models": []}
                    if query.get("status") == ["1"]:
                        data = {"status": data["status"]}
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())

        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.url = "http://127.0.0.1:%d" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join()

    def setUp(self):
        self.assertTrue(CLIENT.is_file(), "The reusable Branchline JSON client must exist")
        spec = importlib.util.spec_from_file_location("branchline_client", CLIENT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.client = self.module.BranchlineClient(self.url, timeout=1)
        self.requests.clear()

    def test_catalog_filter_and_exact_lookup_preserve_saved_labels(self):
        result = self.client.sessions(runtime="codex", search="label", limit=1, refresh=True)
        self.assertEqual([s["label"] for s in result["sessions"]], ["Saved label ☃"])
        self.assertEqual(result["matched"], 1)
        self.assertEqual(self.requests[0], ("/session-catalog", {"refresh": ["1"]}))
        self.assertEqual(self.client.session("other")["session"]["label"], "Other")

    def test_tracked_union_uses_live_native_name_and_preserves_earliest_start_and_latest_activity(self):
        result = self.client.sessions(source="all")
        saved = next(s for s in result["sessions"] if s["id"] == "saved")
        self.assertEqual(saved["label"], "Current native name ☃")
        self.assertEqual(saved["status"], "active")
        self.assertFalse(saved['historical'])
        self.assertEqual(saved['startTime'], 10)
        self.assertEqual(saved['lastActivityTime'], 300)
        self.assertEqual(result['sessions'][0]['id'], 'saved')
        self.assertTrue(result["snapshotAvailable"])
        self.assertEqual(next(s for s in result["sessions"] if s["id"] == "review")["kind"], "review")

    def test_agent_costs_preserve_unknowns_and_use_encoded_session_id(self):
        result = self.client.agents("session /?☃", agent="child / ☃", limit=1)
        self.assertEqual(self.requests[-1], ("/session-cost-history", {"sessionId": ["session /?☃"], "groupBy": ["agent"], "range": ["total"], "resolution": ["auto"]}))
        group = result["agents"][0]
        self.assertIsNone(group["costUSD"])
        self.assertTrue(group["cacheWritesUnknown"])
        self.assertEqual(group["agentName"], "Saved child")
        self.assertNotIn("parent", group)
        self.assertNotIn("points", result)

    def test_cost_window_and_group_scope_do_not_recompute_lifetime_total(self):
        result = self.client.costs("saved", group_by="agent", group='["agent","child / ☃"]', range="window", start=100, end=200, fixed_window=True, series=True, limit=2)
        query = self.requests[-1][1]
        self.assertEqual(query["group"], ['["agent","child / ☃"]'])
        self.assertEqual(query["fixedWindow"], ["true"])
        self.assertEqual(query["start"], ["100"])
        self.assertIsNone(result["history"]["totalCostUSD"])
        self.assertEqual(result["history"]["points"], [{"timestamp": 3, "costUSD": 0.3}, {"timestamp": 4, "costUSD": 0.4}])
        self.assertEqual(result["history"]["burnRate"]["bucketMs"], 60000)
        self.assertNotIn('groups', result['history'])
        self.assertFalse(result['counts']['groups']['available'])
        self.assertNotIn("cacheReuse", result["history"])
        self.assertEqual(len(self.client.costs("saved", details=True)["history"]["cacheReuse"]["agents"]), 1)

    def test_cost_queries_reject_ignored_unknown_groups_and_wrong_session_responses(self):
        for session_id, group in [('ignored-group', '["agent","child / ☃"]'), ('saved', '["agent","not-here"]')]:
            with self.assertRaises(self.module.BranchlineError):
                self.client.costs(session_id, group_by='agent', group=group)
        with self.assertRaises(self.module.BranchlineError):
            self.client.costs('wrong-session')
        with self.assertRaises(self.module.BranchlineError):
            self.client.agents('wrong-session')

    def test_default_activity_retains_model_reasoning_and_structured_usage_without_prose(self):
        spawn = self.client.activity('saved', event_type='agent_spawn')['events'][0]['payload']
        self.assertEqual(spawn['reasoningEffort'], 'high')
        self.assertEqual(spawn['model'], 'claude-sonnet-5-5')
        self.assertNotIn('task', spawn)
        context = self.client.activity('context-session')['events'][0]['payload']
        self.assertEqual(context['usage']['costUSD'], .5)
        self.assertEqual(context['usage']['cacheReadTokens'], 20)
        self.assertEqual(context['breakdown']['systemPrompt'], 12)

    def test_activity_is_bounded_and_omits_private_payload_text_by_default(self):
        result = self.client.activity("saved", agent="child / ☃", limit=2)
        self.assertEqual([e["eventId"] for e in result["events"]], [2, 3])
        self.assertEqual(result["matched"], 3)
        self.assertTrue(result["truncated"])
        self.assertNotIn("private", json.dumps(result))
        self.assertEqual(result["events"][1]["payload"]["tool"], "exec")
        self.assertEqual(self.client.activity("saved", event_type="message", messages=True)["events"][0]["payload"]["content"], "private message")
        raw = self.client.activity("saved", after_event_id=2, raw=True, limit=1)
        self.assertEqual(raw["events"][0]["eventId"], 4)

    def test_spend_summary_preserves_partial_state_without_dumping_lists(self):
        result = self.client.spend(start=0, end=200, timezone="Europe/Berlin", provider="openai", model='["gpt-6-sol",null]')
        self.assertEqual(result["status"]["state"], "indexing")
        self.assertEqual(result["totals"]["unpricedResponses"], 1)
        self.assertNotIn("days", result)
        self.assertNotIn("sessions", result)
        self.assertEqual(self.requests[-1][1]["timezone"], ["Europe/Berlin"])
        result = self.client.spend(section="sessions", limit=1)
        self.assertTrue(result["sessions"][0]["stale"])
        self.assertEqual(self.client.health()["status"]["processed"], 1)
        self.assertEqual(self.requests[-1], ("/spend-overview", {"status": ["1"]}))

    def test_http_json_and_invalid_inputs_have_actionable_errors(self):
        with self.assertRaisesRegex(self.module.BranchlineError, "404.*Cost history"):
            self.client.costs("missing")
        with self.assertRaisesRegex(self.module.BranchlineError, "JSON"):
            self.module.BranchlineClient(self.url + "/broken").sessions()
        for url in ("file:///tmp/history", "http://user:secret@localhost", "http://localhost/?file=x"):
            with self.assertRaises(ValueError):
                self.module.BranchlineClient(url)
        for options in ({"range": "custom", "hours": 0}, {"range": "window", "start": 200, "end": 100}, {"group_by": "typo"}, {"fixed_window": True}):
            with self.assertRaises(ValueError):
                self.client.costs("saved", **options)

    def test_empty_sse_is_unknown_and_redirects_are_not_followed(self):
        result = self.module.BranchlineClient(self.url + "/empty").sessions(source="tracked")
        self.assertFalse(result["snapshotAvailable"])
        self.assertEqual(result["sessions"], [])
        with self.assertRaisesRegex(self.module.BranchlineError, "302"):
            self.module.BranchlineClient(self.url + "/redirect").sessions()
        self.assertEqual(self.requests[-1][0], "/redirect/session-catalog")

    def test_invalid_payloads_and_legacy_agent_grouping_are_reported(self):
        malformed = self.module.BranchlineClient(self.url + "/malformed")
        for command in (malformed.agents, malformed.activity):
            with self.assertRaisesRegex(self.module.BranchlineError, "Invalid"):
                command("saved")
        with self.assertRaisesRegex(self.module.BranchlineError, "agent grouping"):
            self.client.agents("legacy")
        with self.assertRaisesRegex(self.module.BranchlineError, "grouping"):
            self.client.costs("legacy", group_by="agent")

    def test_cli_supports_environment_url_any_cwd_and_json_errors(self):
        env = dict(os.environ, BRANCHLINE_URL=self.url, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, str(CLIENT), "sessions", "--limit", "1"], env=env, cwd="/tmp", capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["sessions"]), 1)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        result = subprocess.run([sys.executable, str(CLIENT), "--url", self.url, "costs", "missing"], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("404", json.loads(result.stderr)["error"])
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
