# Branchline fork modifications; see FORK.md.
"""Check the built UI: uvx --from playwright python scripts/check-phone-controls.py URL."""

import asyncio
import json
import os
import re
import sys
import time
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect


def recording():
    now = int(time.time() * 1000)
    sessions = [
        dict(id="phone-primary", label="Solver review", status="active", startTime=now, lastActivityTime=now),
        dict(id="phone-other", label="Other project", status="active", startTime=now - 5000, lastActivityTime=now - 5000),
    ]
    events = [
        dict(time=0, type="agent_spawn", payload=dict(name="Orchestrator", isMain=True, runtime="claude"), sessionId="phone-primary"),
        dict(time=0.1, type="agent_spawn", payload=dict(name="Reviewer", parent="Orchestrator", runtime="claude"), sessionId="phone-primary"),
        dict(time=0.2, type="message", payload=dict(agent="Reviewer", role="assistant", content="Reviewing the solver boundaries."), sessionId="phone-primary"),
        dict(time=0.3, type="permission_requested", payload=dict(agent="Reviewer"), sessionId="phone-primary"),
        dict(time=0.4, type="agent_spawn", payload=dict(name="Implementer", parent="Orchestrator", runtime="claude"), sessionId="phone-primary"),
        dict(time=0.5, type="agent_spawn", payload=dict(name="Test runner", parent="Implementer", runtime="claude"), sessionId="phone-primary"),
        dict(time=0, type="agent_spawn", payload=dict(name="Orchestrator", isMain=True, runtime="codex"), sessionId="phone-other"),
    ]
    for index, event in enumerate(events):
        event.update(eventId=index + 1, streamId='phone-fixture')
    return "".join("data: " + json.dumps(packet) + "\n\n" for packet in [
        dict(type="session-list", sessions=sessions),
        dict(type="agent-event-batch", events=events),
    ])


async def tree_hierarchy(page):
    tree = page.get_by_role("navigation", name="Session agent tree")
    await expect(tree).to_be_visible(timeout=3000)
    root = tree.get_by_role("button", name="Monitor main session", exact=True)
    await expect(root).to_contain_text("Solver review")
    children = tree.get_by_role("list", name="Subagents of Orchestrator", exact=True)
    reviewer = children.get_by_role("button", name="Monitor Reviewer", exact=True)
    await expect(reviewer).to_contain_text("Waiting for approval")
    nested = children.get_by_role("list", name="Subagents of Implementer", exact=True)
    await expect(nested.get_by_role("button", name="Monitor Test runner", exact=True)).to_be_visible()
    await tree.get_by_role("button", name="Collapse Implementer", exact=True).click()
    await expect(nested).to_be_hidden()
    await expect(reviewer).to_be_visible()
    await tree.get_by_role("button", name="Expand Implementer", exact=True).click()
    await expect(nested).to_be_visible()
    await tree.get_by_role("button", name="Collapse main session", exact=True).click()
    await expect(children).to_be_hidden()
    await expect(root).to_be_visible()
    await tree.get_by_role("button", name="Expand main session", exact=True).click()
    await expect(reviewer).to_be_visible()


async def agent_navigation(page):
    tree = page.get_by_role("navigation", name="Session agent tree")
    reviewer = tree.get_by_role("button", name="Monitor Reviewer", exact=True)
    await expect(reviewer).to_be_visible(timeout=3000)
    await reviewer.click()
    activity = page.get_by_role("region", name="Agent activity")
    await expect(activity).to_contain_text("Reviewer")
    await expect(activity.get_by_text("Reviewing the solver boundaries.", exact=True)).to_be_visible()
    await expect(reviewer).to_have_attribute("aria-pressed", "true")
    await page.get_by_role("button", name="All agents", exact=True).click()
    await expect(activity).to_have_count(0)
    await reviewer.click()
    await page.get_by_role("combobox", name="Main session").select_option("phone-other")
    await expect(activity).to_have_count(0)
    await expect(tree.get_by_role("button", name="Monitor Reviewer", exact=True)).to_have_count(0)
    await expect(tree.get_by_role("button", name="Monitor main session", exact=True)).to_contain_text("Other project")


async def portrait_controls(page):
    tree = page.get_by_role("navigation", name="Session agent tree")
    await expect(tree).to_be_visible(timeout=3000)
    controls = tree.get_by_role("button")
    for control in [page.get_by_role("combobox", name="Main session")] + [controls.nth(i) for i in range(await controls.count())] + [page.get_by_role("button", name=name, exact=True) for name in ["Tree", "Graph", "Files", "Chat", "$Cost", "Timeline"]]:
        box = await control.bounding_box()
        assert box and box["x"] >= 0 and box["x"] + box["width"] <= page.viewport_size["width"], f"Control outside viewport: {box}"
        assert box["height"] >= 44, f"Touch target too short: {box}"
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Page scrolls horizontally"


async def graph_panels(page):
    await page.get_by_role("button", name="Graph", exact=True).click()
    await expect(page.get_by_role("navigation", name="Session agent tree")).to_have_count(0)
    header = page.get_by_role("region", name="Agent controls")
    header_box = await header.bounding_box()
    header_bottom = header_box["y"] + header_box["height"]
    preview = page.get_by_text("Reviewing the solver boundaries.", exact=True)
    await expect(preview).to_be_visible()
    box = await preview.bounding_box()
    assert box["y"] >= header_bottom, "Message preview overlaps controls"
    await preview.click()
    await expect(page.get_by_text("MESSAGES", exact=True)).to_be_visible()
    for name, title in [("Files", "FILE ATTENTION"), ("Chat", "TRANSCRIPT")]:
        await page.get_by_role("button", name=name, exact=True).click()
        panel_title = page.get_by_text(title, exact=True)
        await expect(panel_title).to_be_visible()
        box = await panel_title.bounding_box()
        assert box["y"] >= header_bottom, f"{name} overlaps controls"
        await page.get_by_role("button", name="Tree", exact=True).click(trial=True, timeout=1000)
    await page.get_by_role("button", name="Chat", exact=True).click()
    await page.get_by_role("button", name="Tree", exact=True).click()
    await expect(page.get_by_role("navigation", name="Session agent tree")).to_be_visible()


async def tree_keyboard(page):
    reviewer = page.get_by_role("navigation", name="Session agent tree").get_by_role("button", name="Monitor Reviewer", exact=True)
    await expect(reviewer).to_be_visible()
    await reviewer.focus()
    await reviewer.press("Space")
    await expect(page.get_by_role("region", name="Agent activity")).to_contain_text("Reviewer")
    await reviewer.press("c")
    await expect(page.get_by_role("button", name="Chat", exact=True)).to_have_attribute("aria-pressed", "false")


async def activity_reading(page):
    await page.get_by_role("button", name="Monitor Reviewer", exact=True).click()
    log = page.get_by_role("log", name="Agent messages")

    async def send_messages(contents):
        events = [dict(time=1 + index / 100, type="message", payload=dict(agent="Reviewer", role="assistant", content=content), sessionId="phone-primary") for index, content in enumerate(contents)]
        await page.evaluate("packet => window.postMessage(packet, '*')", dict(type="agent-event-batch", events=events))

    await send_messages([f"History {index}: " + "Reading earlier activity. " * 20 for index in range(30)])
    await expect(log).to_contain_text("History 29:")
    await log.evaluate("element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); }")
    await send_messages(["A new live message while reading history."])
    await expect(log).to_contain_text("A new live message while reading history.")
    await page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
    assert await log.evaluate("element => element.scrollTop") <= 1, "New activity moved the reader away from earlier messages"

    await log.evaluate("element => { element.scrollTop = element.scrollHeight - element.clientHeight - 10; element.dispatchEvent(new Event('scroll')); }")
    await send_messages(["Follow the latest activity again. " * 20])
    await expect(log).to_contain_text("Follow the latest activity again.")
    await page.wait_for_function("() => { const element = document.querySelector('[role=log]'); return element && element.scrollHeight - element.clientHeight - element.scrollTop <= 1; }")


async def same_session_live(page):
    await page.get_by_role("button", name="Monitor Reviewer", exact=True).click()
    picker = page.get_by_role("combobox", name="Main session")
    await picker.dispatch_event("change")
    event = dict(time=2, type="message", payload=dict(agent="Reviewer", role="assistant", content="Fresh activity after selecting the same session."), sessionId="phone-primary", eventId=1000, streamId="phone-fixture")
    await page.evaluate("event => window.postMessage({type:'agent-event',event},'*')", event)
    await expect(page.get_by_role("log", name="Agent messages")).to_contain_text("Fresh activity after selecting the same session.")


async def cold_session_history(page):
    await page.get_by_role("combobox", name="Main session").select_option("phone-other")
    await expect(page.get_by_role("button", name="Monitor main session", exact=True)).to_contain_text("Other project")
    await expect(page.get_by_role("alert")).to_have_count(0)


async def live_during_history_fetch(page):
    async def delayed_replay(route):
        await asyncio.sleep(0.25)
        session_id = parse_qs(urlparse(route.request.url).query)['sessionId'][0]
        packets = [json.loads(line[6:]) for line in recording().splitlines() if line.startswith('data: ')]
        events = [event for event in packets[1]['events'] if event['sessionId'] == session_id]
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId='phone-fixture', throughEventId=max(event['eventId'] for event in events), events=events)))
    await page.route('**/session-events?*', delayed_replay)
    await page.get_by_role("combobox", name="Main session").select_option("phone-other")
    event = dict(time=3, type="message", payload=dict(agent="Orchestrator", role="assistant", content="Arrived during history refresh."), sessionId="phone-other", eventId=1001, streamId="phone-fixture")
    await page.evaluate("event => window.postMessage({type:'agent-event',event},'*')", event)
    await expect(page.get_by_role("status")).to_have_count(0)
    await page.get_by_role("button", name="Monitor main session", exact=True).click()
    await expect(page.get_by_role("log", name="Agent messages")).to_contain_text("Arrived during history refresh.")


async def delayed_replay_cannot_regress_state(page):
    spawn = dict(time=0, type="agent_spawn", payload=dict(name="Orchestrator", isMain=True, runtime="codex"), sessionId="phone-other", eventId=7, streamId="phone-fixture")
    context = dict(time=2, type="context_update", payload=dict(agent="Orchestrator", tokens=9000), sessionId="phone-other", eventId=90, streamId="phone-fixture")
    async def fresh_replay(route):
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId='phone-fixture', throughEventId=100, events=[spawn, context])))
    await page.route('**/session-events?*', fresh_replay)
    await page.get_by_role("combobox", name="Main session").select_option("phone-other")
    await expect(page.get_by_role("status")).to_have_count(0)
    await page.get_by_role("button", name="Monitor main session", exact=True).click()
    activity = page.get_by_role("region", name="Agent activity")
    await expect(activity).to_contain_text("9k tokens")
    older = dict(context, eventId=50, payload=dict(agent="Orchestrator", tokens=100))
    await page.evaluate("event => window.postMessage({type:'agent-event-batch',events:[event]},'*')", older)
    await page.wait_for_timeout(600)
    assert "9k tokens" in await activity.inner_text(), "Delayed history overwrote newer context state"
    retired = dict(older, streamId='retired-fixture')
    await page.evaluate("event => window.postMessage({type:'agent-event',event},'*')", retired)
    await page.wait_for_timeout(600)
    assert "9k tokens" in await activity.inner_text(), "A retired server stream overwrote current state"
    newer = dict(context, eventId=101, payload=dict(agent="Orchestrator", tokens=10000))
    await page.evaluate("event => window.postMessage({type:'agent-event',event},'*')", newer)
    await expect(activity).to_contain_text("10k tokens")


async def failed_history_can_retry(page):
    async def failed_replay(route):
        await route.fulfill(status=503, body='temporarily unavailable')
    await page.route('**/session-events?*', failed_replay)
    await page.get_by_role("combobox", name="Main session").select_option("phone-other")
    await expect(page.get_by_role("alert")).to_contain_text("Could not load")
    await page.unroute('**/session-events?*', failed_replay)
    await page.get_by_role("button", name="Retry", exact=True).click()
    await expect(page.get_by_role("alert")).to_have_count(0)
    await expect(page.get_by_role("button", name="Monitor main session", exact=True)).to_contain_text("Other project")


async def reset_same_session_keeps_live_updates(page):
    await page.get_by_role("combobox", name="Main session").select_option("phone-other")
    await expect(page.get_by_role("status")).to_have_count(0)
    await expect(page.get_by_role("button", name="Monitor main session", exact=True)).to_contain_text("Other project")
    session = dict(id='phone-other', label='Other project', status='active', startTime=1, lastActivityTime=1)
    spawn = dict(time=0, type="agent_spawn", payload=dict(name="Orchestrator", isMain=True, runtime="codex"), sessionId="phone-other", eventId=1, streamId="reset-fixture")
    message = dict(time=1, type="message", payload=dict(agent="Orchestrator", role="assistant", content="Fresh history after reset."), sessionId="phone-other", eventId=2, streamId="reset-fixture")
    async def reset_replay(route):
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId='reset-fixture', throughEventId=2, events=[spawn, message])))
    await page.route('**/session-events?*', reset_replay)
    await page.evaluate("""packets => {
      for (const data of packets) window.dispatchEvent(new MessageEvent('message', {data}));
    }""", [dict(type='reset'), dict(type='session-list', sessions=[session]), dict(type='agent-event-batch', events=[spawn, message])])
    await page.wait_for_timeout(600)
    await page.get_by_role("button", name="Monitor main session", exact=True).click()
    assert "Fresh history after reset." in await page.get_by_role("log", name="Agent messages").inner_text(), "Reset to the same session left stale activity visible"
    event = dict(time=2, type='context_update', payload=dict(agent='Orchestrator', tokens=10000), sessionId='phone-other', eventId=3, streamId='reset-fixture')
    await page.evaluate("event => window.postMessage({type:'agent-event',event},'*')", event)
    await expect(page.get_by_role("region", name="Agent activity")).to_contain_text("10k tokens")


async def reconnect_refreshes_selected_history(page):
    await page.get_by_role("combobox", name="Main session").select_option("phone-other")
    await expect(page.get_by_role("status")).to_have_count(0)
    async def updated_replay(route):
        spawn = dict(time=0, type="agent_spawn", payload=dict(name="Orchestrator", isMain=True, runtime="codex"), sessionId="phone-other", eventId=7, streamId="phone-fixture")
        recovered = dict(time=4, type="message", payload=dict(agent="Orchestrator", role="assistant", content="Recovered activity after reconnect."), sessionId="phone-other", eventId=1008, streamId="phone-fixture")
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId='phone-fixture', throughEventId=1008, events=[spawn, recovered])))
    await page.route('**/session-events?*', updated_replay)
    await page.evaluate("() => window.__phoneEventSources[0].onopen(new Event('open'))")
    await expect(page.get_by_role("status")).to_have_count(0)
    await page.get_by_role("button", name="Monitor main session", exact=True).click()
    await expect(page.get_by_role("log", name="Agent messages")).to_contain_text("Recovered activity after reconnect.")


async def new_stream_live_during_reconnect(page):
    await page.get_by_role("combobox", name="Main session").select_option("phone-other")
    await expect(page.get_by_role("status")).to_have_count(0)
    started, release = asyncio.Event(), asyncio.Event()
    spawn = dict(time=0, type="agent_spawn", payload=dict(name="Orchestrator", isMain=True, runtime="codex"), sessionId="phone-other", eventId=1, streamId="reconnected-fixture")
    context = dict(time=1, type="context_update", payload=dict(agent="Orchestrator", tokens=2000), sessionId="phone-other", eventId=2, streamId="reconnected-fixture")
    async def held_replay(route):
        started.set()
        await release.wait()
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId='reconnected-fixture', throughEventId=2, events=[spawn, context])))
    await page.route('**/session-events?*', held_replay)
    await page.evaluate("() => window.__phoneEventSources[0].onopen(new Event('open'))")
    await asyncio.wait_for(started.wait(), 3)
    newer = dict(context, eventId=3, payload=dict(agent='Orchestrator', tokens=3000))
    await page.evaluate("event => window.dispatchEvent(new MessageEvent('message',{data:{type:'agent-event',event}}))", newer)
    release.set()
    await expect(page.get_by_role("status")).to_have_count(0)
    await page.get_by_role("button", name="Monitor main session", exact=True).click()
    await expect(page.get_by_role("region", name="Agent activity")).to_contain_text("3k tokens", timeout=1800)


async def context_bars_fit_portrait(page):
    breakdown = dict(systemPrompt=5000, userMessages=987134, toolResults=2601297, reasoning=550333, subagentResults=274)
    events = [
        dict(time=5, type='model_detected', payload=dict(agent='Reviewer', model='claude-opus-5-5'), sessionId='phone-primary', eventId=1010, streamId='phone-fixture'),
        dict(time=5, type='context_update', payload=dict(agent='Reviewer', tokens=4144038, tokensMax=1000000, breakdown=breakdown), sessionId='phone-primary', eventId=1011, streamId='phone-fixture'),
        dict(time=5, type='context_update', payload=dict(agent='Orchestrator', tokens=222366, tokensMax=1000000, breakdown=breakdown), sessionId='phone-primary', eventId=1012, streamId='phone-fixture'),
    ]
    await page.evaluate("events => window.postMessage({type:'agent-event-batch',events},'*')", events)
    await page.get_by_role('button', name='Graph', exact=True).click()
    await page.wait_for_function('() => window.__contextBars?.length >= 10')
    await page.wait_for_timeout(700)
    bars = await page.evaluate('window.__contextBars.slice(-20)')
    for bar in bars:
        for fill in bar['fills']:
            assert fill['x'] >= bar['x'] - 0.01 and fill['x'] + fill['width'] <= bar['x'] + bar['width'] + 0.01, 'A context segment extends past its track'
        assert bar['left'] >= 0 and bar['right'] <= page.viewport_size['width'], 'A context bar extends outside the portrait viewport'
    if page.viewport_size['width'] == 390:
        await page.screenshot(path='/tmp/agent-flow-context-portrait.png')


def rgba(value):
    parts = [float(number) for number in re.findall(r"[\d.]+", value)]
    return parts + [1] if len(parts) == 3 else parts


def blend(foreground, background):
    return [foreground[i] * foreground[3] + background[i] * (1 - foreground[3]) for i in range(3)] + [1]


def luminance(color):
    values = [channel / 255 for channel in color[:3]]
    values = [channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4 for channel in values]
    return sum(channel * weight for channel, weight in zip(values, [0.2126, 0.7152, 0.0722]))


async def header_contrast(page):
    for name in ["Files", "Chat", "$Cost", "Timeline"]:
        button = page.get_by_role("button", name=name, exact=True)
        colors = await button.evaluate("""element => {
          const backgrounds = [];
          for (let parent = element; parent; parent = parent.parentElement) {
            backgrounds.unshift(getComputedStyle(parent).backgroundColor);
          }
          return { text: getComputedStyle(element).color, backgrounds };
        }""")
        background = [10, 10, 26, 1]
        for layer in colors["backgrounds"]:
            background = blend(rgba(layer), background)
        foreground = blend(rgba(colors["text"]), background)
        light, dark = sorted([luminance(foreground), luminance(background)], reverse=True)
        ratio = (light + 0.05) / (dark + 0.05)
        assert ratio >= 4.5, f"{name} text contrast is {ratio:.2f}:1; expected at least 4.5:1"


async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3001"
    requested = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else None
    failures = []
    async with async_playwright() as playwright:
        launch = dict(headless=True, args=["--no-sandbox"])
        if os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
            launch["executable_path"] = os.environ["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
        browser = await playwright.chromium.launch(**launch)
        for width in [360, 390, 1280]:
            for check in [tree_hierarchy, agent_navigation, portrait_controls, header_contrast, graph_panels, tree_keyboard, activity_reading, same_session_live, cold_session_history, live_during_history_fetch, delayed_replay_cannot_regress_state, failed_history_can_retry, reconnect_refreshes_selected_history, reset_same_session_keeps_live_updates, new_stream_live_during_reconnect, context_bars_fit_portrait]:
                if requested and check.__name__ not in requested:
                    continue
                context = await browser.new_context(viewport=dict(width=width, height=844), is_mobile=width < 640, has_touch=width < 640)
                page = await context.new_page()
                if check is context_bars_fit_portrait:
                    await page.add_init_script("""window.__contextBars = [];
                      const fills = new WeakMap();
                      const originalFill = CanvasRenderingContext2D.prototype.fillRect;
                      const originalStroke = CanvasRenderingContext2D.prototype.strokeRect;
                      CanvasRenderingContext2D.prototype.fillRect = function(x,y,width,height) {
                        if (height === 6) { const pending = fills.get(this) || []; pending.push({x,y,width}); fills.set(this,pending); }
                        return originalFill.call(this,x,y,width,height);
                      };
                      CanvasRenderingContext2D.prototype.strokeRect = function(x,y,width,height) {
                        if (height === 6) {
                          const transform = this.getTransform();
                          const left = transform.transformPoint(new DOMPoint(x,y)).x;
                          const right = transform.transformPoint(new DOMPoint(x+width,y)).x;
                          window.__contextBars.push({x,width,left,right,fills:(fills.get(this)||[]).filter(fill=>Math.abs(fill.y-y)<0.01)});
                          if(window.__contextBars.length>200) window.__contextBars.shift();
                          fills.delete(this);
                        }
                        return originalStroke.call(this,x,y,width,height);
                      };""")
                if check in [reconnect_refreshes_selected_history, new_stream_live_during_reconnect]:
                    await page.add_init_script("""window.__phoneEventSources = [];
                      const NativeEventSource = window.EventSource;
                      window.EventSource = class extends NativeEventSource {
                        constructor(...args) { super(...args); window.__phoneEventSources.push(this); }
                      };""")
                page.set_default_timeout(2500)
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                body = recording()
                if check is cold_session_history:
                    packets = [json.loads(line[6:]) for line in body.splitlines() if line.startswith('data: ')]
                    packets[1]['events'] = [event for event in packets[1]['events'] if event['sessionId'] == 'phone-primary']
                    body = ''.join('data: ' + json.dumps(packet) + '\n\n' for packet in packets)
                await page.route("**/events", lambda route: route.fulfill(status=200, content_type="text/event-stream", body=body))
                async def replay_route(route):
                    session_id = parse_qs(urlparse(route.request.url).query)['sessionId'][0]
                    packets = [json.loads(line[6:]) for line in recording().splitlines() if line.startswith('data: ')]
                    events = [event for event in packets[1]['events'] if event['sessionId'] == session_id]
                    await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId='phone-fixture', throughEventId=max(event['eventId'] for event in events), events=events)))
                await page.route('**/session-events?*', replay_route)
                try:
                    await page.goto(url, wait_until="domcontentloaded")
                    await expect(page.get_by_role("combobox", name="Main session")).to_have_value("phone-primary")
                    await check(page)
                    assert not errors, f"Browser errors: {errors}"
                    if width == 390 and check is portrait_controls:
                        await page.screenshot(path="/tmp/agent-flow-phone-controls.png")
                        await page.get_by_role("button", name="Monitor Reviewer", exact=True).click()
                        await expect(page.get_by_role("region", name="Agent activity")).to_be_visible()
                        await page.screenshot(path="/tmp/agent-flow-phone-reviewer.png")
                    print("PASS", width, check.__name__, flush=True)
                except Exception as error:
                    failures.append(f"{width}/{check.__name__}")
                    print("FAIL", width, check.__name__, str(error).split("Call log:")[0].strip(), flush=True)
                finally:
                    await context.close()
        await browser.close()
    if failures:
        raise SystemExit(f"{len(failures)} browser checks failed: {', '.join(failures)}")


if __name__ == '__main__':
    asyncio.run(main())
