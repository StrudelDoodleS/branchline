#!/usr/bin/env python3
"""Read Branchline's local HTTP API. Standard library only; no log-file access.

Reusable API: BranchlineClient.{sessions,session,agents,costs,activity,spend,health}.
The CLI prints one compact JSON object; request failures go to stderr (exit 1).
"""
import argparse
import json
import math
import os
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


DEFAULT_URL = "http://127.0.0.1:3001"
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
COST_SCOPE = "totalCostUSD and groups are lifetime usage; window and series use the requested range. group selects total/series, not the server's group list."


class BranchlineError(Exception):
    def __init__(self, message, *, kind="request", status=None):
        super().__init__(message)
        self.kind, self.status = kind, status


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def _limit(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 1000:
        raise ValueError("limit must be an integer from 1 to 1000")
    return value


def _number(value, name, minimum=0, maximum=8640000000000000):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("Invalid " + name)
    return value


def _rows(rows, limit):
    return {"matched": len(rows), "returned": min(len(rows), limit), "truncated": len(rows) > limit}


class BranchlineClient:
    def __init__(self, url=None, timeout=5):
        self.url = (url or os.environ.get("BRANCHLINE_URL") or DEFAULT_URL).rstrip("/")
        parsed = urlsplit(self.url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
            raise ValueError("URL must be an http(s) service address without credentials, query, or fragment")
        try:
            parsed.port
        except ValueError as error:
            raise ValueError("Invalid service port") from error
        self.timeout = _number(timeout, "timeout (seconds)", 0.01, 120)
        # Local usage data must not go through an ambient proxy or HTTP redirect.
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    def _open(self, endpoint, params=None, accept="application/json"):
        query = urlencode({key: value for key, value in (params or {}).items() if value is not None})
        request = Request(self.url + endpoint + ("?" + query if query else ""), headers={"Accept": accept})
        try:
            return self._opener.open(request, timeout=self.timeout)
        except HTTPError as error:
            with error:
                body = error.read(2048)
            try:
                message = str(json.loads(body).get("error", error.reason))[:300]
            except (ValueError, AttributeError):
                message = str(error.reason)
            raise BranchlineError("HTTP %s at %s: %s" % (error.code, endpoint, message), status=error.code) from error
        except (TimeoutError, socket.timeout) as error:
            raise BranchlineError("Timed out at " + endpoint, kind="timeout") from error
        except URLError as error:
            kind = "timeout" if isinstance(error.reason, (TimeoutError, socket.timeout)) else "connection"
            raise BranchlineError("Cannot reach Branchline at %s (%s); check the service URL and timeout" % (endpoint, kind), kind=kind) from error
        except OSError as error:
            raise BranchlineError("Connection failed at " + endpoint, kind="connection") from error

    def _json(self, endpoint, params=None):
        try:
            with self._open(endpoint, params) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise BranchlineError("Response exceeds 64 MiB at " + endpoint)
            data = json.loads(body)
        except (ValueError, UnicodeError) as error:
            raise BranchlineError("Invalid JSON at " + endpoint) from error
        except (TimeoutError, socket.timeout) as error:
            raise BranchlineError("Timed out reading " + endpoint, kind="timeout") from error
        except OSError as error:
            raise BranchlineError("Connection interrupted at " + endpoint) from error
        if not isinstance(data, dict):
            raise BranchlineError("Expected a JSON object at " + endpoint)
        return data

    def _tracked(self):
        deadline, consumed, data = time.monotonic() + self.timeout, 0, []
        try:
            with self._open("/events", accept="text/event-stream") as response:
                while time.monotonic() < deadline:
                    line = response.readline(MAX_RESPONSE_BYTES - consumed + 1)
                    consumed += len(line)
                    if consumed > MAX_RESPONSE_BYTES:
                        raise BranchlineError("SSE snapshot exceeds 64 MiB")
                    if not line or line.strip() == b"":
                        if data:
                            event = json.loads("\n".join(data))
                            if isinstance(event, dict) and event.get("type") == "session-list" and isinstance(event.get("sessions"), list):
                                return event["sessions"], True
                            data = []
                        if not line:
                            break
                    elif line.startswith(b"data:"):
                        data.append(line[5:].decode("utf-8").strip())
        except (TimeoutError, socket.timeout):
            pass
        except BranchlineError as error:
            if error.kind != "timeout":
                raise
        except (ValueError, UnicodeError) as error:
            raise BranchlineError("Invalid session-list JSON in SSE snapshot") from error
        return [], False

    def _session_rows(self, source, refresh=False):
        if source not in ("saved", "tracked", "all"):
            raise ValueError("source must be saved, tracked, or all")
        saved = self._json("/session-catalog", {"refresh": "1" if refresh else None}).get("sessions") if source != "tracked" else []
        if not isinstance(saved, list) or any(not isinstance(row, dict) or not isinstance(row.get("id"), str) for row in saved):
            raise BranchlineError("Invalid saved session catalog")
        tracked, available = self._tracked() if source != "saved" else ([], None)
        if any(not isinstance(row, dict) or not isinstance(row.get("id"), str) for row in tracked):
            raise BranchlineError("Invalid tracked session snapshot")
        merged = {row["id"]: dict(row) for row in saved}
        for row in tracked:
            previous = merged.get(row["id"], {})
            merged[row["id"]] = {**previous, **row, "historical": row.get("historical") or False,
                                 "startTime": previous.get("startTime", row.get("startTime")),
                                 "lastActivityTime": max(previous.get("lastActivityTime") or 0, row.get("lastActivityTime") or 0)}
        meta = {"source": source, "snapshotAvailable": available}
        if available is False:
            meta["note"] = "No session-list frame before EOF/timeout. The relay sends no frame when empty; tracked state is unknown."
        return list(merged.values()), meta

    def sessions(self, *, source="saved", runtime=None, provider=None, status=None, kind=None, search=None, limit=20, refresh=False):
        limit = _limit(limit)
        rows, meta = self._session_rows(source, refresh)
        available = len(rows)
        rows = [row for row in rows if all(value is None or row.get(key) == value for key, value in (("runtime", runtime), ("provider", provider), ("status", status), ("kind", kind)))
                and (not search or search.casefold() in " ".join(str(row.get(key, "")) for key in ("id", "label", "project")).casefold())]
        rows.sort(key=lambda row: row.get("lastActivityTime") or 0, reverse=True)
        return {**meta, "available": available, **_rows(rows, limit), "sessions": rows[:limit]}

    def session(self, session_id, *, source="saved", refresh=False):
        rows, meta = self._session_rows(source, refresh)
        row = next((row for row in rows if row["id"] == session_id), None)
        if row is None:
            raise BranchlineError("Session not found in %s sessions; try another --source" % source, status=404)
        return {**meta, "session": row}

    def costs(self, session_id, *, group_by="model", group=None, range="total", hours=None, start=None, end=None, fixed_window=False, resolution="auto", series=False, details=False, limit=20):
        limit = _limit(limit)
        if not session_id or group_by not in ("model", "model-reasoning", "agent") or resolution not in ("auto", "minute", "hour", "day") or range not in ("total", "1h", "2h", "custom", "window"):
            raise ValueError("Invalid session, group_by, range, or resolution")
        if group is not None and (not isinstance(group, str) or not 1 <= len(group) <= 1024):
            raise ValueError("group must be an exact group.id (1–1024 characters)")
        if range == "custom":
            _number(hours, "hours", 1 / 60, 8760)
        elif hours is not None:
            raise ValueError("hours requires range=custom")
        if range == "window":
            _number(start, "start"); _number(end, "end")
            if end <= start:
                raise ValueError("end must follow start")
        elif start is not None or end is not None or fixed_window:
            raise ValueError("start, end, and fixed_window require range=window")
        result = self._json("/session-cost-history", {"sessionId": session_id, "groupBy": group_by, "group": group, "range": range, "resolution": resolution,
                            "hours": hours, "start": start, "end": end, "fixedWindow": "true" if fixed_window else None})
        history = result.get("history")
        if result.get('sessionId') != session_id or not isinstance(history, dict):
            raise BranchlineError("Invalid cost history")
        if history.get("groupBy") != group_by:
            raise BranchlineError("This server did not honor the requested cost grouping; update the running service")
        groups = history.get('groups')
        omitted = groups is None and fixed_window and group_by == 'agent'
        if not omitted and (not isinstance(groups, list) or any(not isinstance(row, dict) for row in groups)):
            raise BranchlineError('Invalid cost groups')
        if group is not None:
            if history.get('group') != group:
                raise BranchlineError('This server did not honor the requested cost group; update the running service')
            if not omitted and not any(row.get('id') == group for row in groups):
                raise BranchlineError('Cost group not found in this session; use an exact id from agents or costs', status=404)
        history = dict(history)
        if omitted:
            history.pop('groups', None)
            counts = {'groups': {'available': False, 'note': 'Agent summaries omitted from fixed-window comparison response; use agents for the full session list.'}}
        else:
            history["groups"] = groups[:limit]
            counts = {"groups": _rows(groups, limit)}
        for key in ("points", "burnRate"):
            value = history.pop(key, None)
            if series and value is not None:
                points = value.get("points", []) if key == "burnRate" else value
                counts[key] = _rows(points, limit)
                history[key] = {**value, "points": points[-limit:]} if key == "burnRate" else points[-limit:]
        if not details:
            history.pop("cacheReuse", None)
        return {"sessionId": session_id, "source": "session-cost-history", "scope": COST_SCOPE, "counts": counts, "history": history}

    def agents(self, session_id, *, agent=None, limit=20):
        limit = _limit(limit)
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("session_id is required")
        # Get all groups before filtering so a small output limit cannot hide an exact match.
        data = self._json("/session-cost-history", {"sessionId": session_id, "groupBy": "agent", "range": "total", "resolution": "auto"})
        history = data.get("history")
        if data.get('sessionId') != session_id or not isinstance(history, dict) or not isinstance(history.get("groups"), list) or any(not isinstance(row, dict) for row in history["groups"]):
            raise BranchlineError("Invalid agent cost groups; this server may need the Branchline agent grouping update")
        if history.get("groupBy") != "agent":
            raise BranchlineError("This server does not support Branchline agent grouping; update the running service")
        groups = history["groups"]
        groups = [row for row in groups if agent is None or agent in (row.get("agentId"), row.get("agentName"), row.get("id"))]
        return {"sessionId": session_id, "source": "session-cost-history", "scope": "Lifetime cost-bearing agents; not a complete agent roster or parent tree.", **_rows(groups, limit), "agents": groups[:limit]}

    def activity(self, session_id, *, agent=None, event_type=None, after_event_id=None, messages=False, raw=False, limit=20):
        limit = _limit(limit)
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("session_id is required")
        if after_event_id is not None:
            _number(after_event_id, "after_event_id")
        data = self._json("/session-events", {"sessionId": session_id})
        events = data.get("events")
        if not isinstance(events, list) or any(not isinstance(event, dict) or not isinstance(event.get("payload"), dict) for event in events):
            raise BranchlineError("Invalid activity replay")
        available = len(events)
        events = [event for event in events if (event_type is None or event.get("type") == event_type)
                  and (after_event_id is None or event.get("eventId", -1) > after_event_id)
                  and (agent is None or agent in [event.get("payload", {}).get(key) for key in ("agent", "name", "child", "parent")])]
        counts, selected = _rows(events, limit), events[-limit:]
        if not raw:
            safe = {"agent", "name", "parent", "child", "displayName", "runtime", "role", "tool", "model", "reasoningEffort", "effort", "perTurnEffort", "provider", "usage", "breakdown"}
            text_keys = {"content", "task", "summary", "errorMessage"} if messages else set()
            selected = [{**{key: value for key, value in event.items() if key != "payload"},
                         "payload": {key: (value[:1000] if key in text_keys and isinstance(value, str) else value)
                                     for key, value in event.get("payload", {}).items() if key in safe or key in text_keys or isinstance(value, (int, float, bool)) or value is None}}
                        for event in selected]
        return {"sessionId": session_id, "source": "session-events", "scope": "Bounded in-memory replay; event time is session-relative, not an epoch timestamp. Saved sessions may have no replay.",
                "streamId": data.get("streamId"), "throughEventId": data.get("throughEventId"), "available": available, **counts, "messagesIncluded": messages or raw, "events": selected}

    def spend(self, *, start=None, end=None, timezone="UTC", provider=None, model=None, refresh=False, section="summary", limit=20):
        limit = _limit(limit)
        if section not in ("summary", "sessions", "models", "providers", "days", "all"):
            raise ValueError("Invalid spend section")
        if start is not None:
            _number(start, "start")
        if end is not None:
            _number(end, "end")
        if start is not None and end is not None and end <= start:
            raise ValueError("end must follow start")
        data = self._json("/spend-overview", {"start": start, "end": end, "timezone": timezone, "provider": provider, "model": model, "refresh": "1" if refresh else None})
        result = {key: data[key] for key in ("status", "window", "totals") if key in data}
        result.update(source="spend-overview", scope="Local indexed saved sessions; totals cover the server query, not the limited lists. Check status and stale/indexed flags.", counts={})
        for key in ("sessions", "models", "providers", "days"):
            rows = data.get(key, [])
            result["counts"][key] = _rows(rows, limit)
            if section in (key, "all"):
                # Server ranks models/providers; session rows need a useful top-spend order.
                ordered = sorted(rows, key=lambda row: row.get("knownCostUSD", 0), reverse=True) if key == "sessions" else rows
                result[key] = ordered[-limit:] if key == "days" else ordered[:limit]
        return result

    def health(self):
        return {"source": "spend-overview?status=1", **self._json("/spend-overview", {"status": "1"})}

    def describe(self):
        return {"url": self.url, "commands": ["sessions", "session", "agents", "costs", "activity", "spend", "health"],
                "defaultLimit": 20, "maximumLimit": 1000, "timeoutSeconds": self.timeout, "network": "Read-only fixed HTTP endpoints; no external pricing requests, redirects, proxy use, or log-file access.",
                "help": "Use COMMAND --help. health reads indexing status without starting indexing; spend can start indexing. No automatic retries or polling."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Service URL (default BRANCHLINE_URL or http://127.0.0.1:3001)")
    parser.add_argument("--timeout", type=float, default=5, help="Request timeout in seconds (default 5)")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("describe", "health"):
        commands.add_parser(name)
    for name in ("sessions", "session"):
        cmd = commands.add_parser(name)
        cmd.add_argument("--source", choices=("saved", "tracked", "all"), default="saved")
        cmd.add_argument("--refresh", action="store_true")
        if name == "session":
            cmd.add_argument("session_id")
        else:
            for flag in ("runtime", "provider", "status", "kind", "search"):
                cmd.add_argument("--" + flag)
            cmd.add_argument("--limit", type=int, default=20)
    for name in ("agents", "costs", "activity"):
        cmd = commands.add_parser(name)
        cmd.add_argument("session_id")
        cmd.add_argument("--limit", type=int, default=20)
        if name == "agents":
            cmd.add_argument("--agent", help="Exact agentId, agentName, or group.id")
        elif name == "activity":
            cmd.add_argument("--agent", help="Exact event participant id/name")
            cmd.add_argument("--event-type")
            cmd.add_argument("--after-event-id", type=int)
            cmd.add_argument("--messages", action="store_true", help="Include content/task/summary text, at most 1000 characters each")
            cmd.add_argument("--raw", action="store_true", help="Complete payloads for the selected events")
        else:
            cmd.add_argument("--group-by", choices=("model", "model-reasoning", "agent"), default="model")
            cmd.add_argument("--group", help="Exact group.id from an earlier cost/agents result")
            cmd.add_argument("--range", choices=("total", "1h", "2h", "custom", "window"), default="total")
            cmd.add_argument("--hours", type=float)
            cmd.add_argument("--start", type=int, help="Epoch milliseconds, with --range window")
            cmd.add_argument("--end", type=int, help="Epoch milliseconds, with --range window")
            cmd.add_argument("--fixed-window", action="store_true")
            cmd.add_argument("--resolution", choices=("auto", "minute", "hour", "day"), default="auto")
            cmd.add_argument("--series", action="store_true", help="Include the latest limited cost/burn points")
            cmd.add_argument("--details", action="store_true", help="Include full cacheReuse diagnostics for this session")
    cmd = commands.add_parser("spend")
    for flag in ("start", "end"):
        cmd.add_argument("--" + flag, type=int, help="Epoch milliseconds; prefer whole local day boundaries")
    cmd.add_argument("--timezone", default="UTC")
    cmd.add_argument("--provider")
    cmd.add_argument("--model", help='Exact model group.id, e.g. ["gpt-6-sol",null]')
    cmd.add_argument("--refresh", action="store_true")
    cmd.add_argument("--section", choices=("summary", "sessions", "models", "providers", "days", "all"), default="summary")
    cmd.add_argument("--limit", type=int, default=20)
    args = vars(parser.parse_args(argv))
    command, url, timeout = (args.pop(key) for key in ("command", "url", "timeout"))
    try:
        result = getattr(BranchlineClient(url, timeout), command)(**args)
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
        return 0
    except (BranchlineError, ValueError) as error:
        import sys
        print(json.dumps({"error": str(error)}, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
