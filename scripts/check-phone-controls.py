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


async def reported_usage_costs(page):
    header = page.get_by_role('region', name='Agent controls')
    await expect(header).to_be_visible()
    usage = dict(inputTokens=2000, outputTokens=1000, cacheReadTokens=8000, cacheWriteTokens=500,
                 cacheWrite1hTokens=200, reasoningTokens=400, totalTokens=11500, costUSD=1.25)
    events = [dict(time=2, type='context_update', payload=dict(agent=agent, tokens=100, usage=usage),
                   sessionId='phone-primary', eventId=1000+i, streamId='phone-fixture')
              for i,agent in enumerate(['Orchestrator', 'Reviewer'])]
    await page.evaluate("events => window.postMessage({type:'agent-event-batch',events},'*')", events)
    await expect(header).to_contain_text('~$2.50 API')
    # Duplicate replay replaces the totals; context fill is unrelated to billing.
    await page.evaluate("events => window.postMessage({type:'agent-event-batch',events},'*')", events)
    await expect(header).to_contain_text('23k tokens used')
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs')
    await cost_tools(panel, tab='Spend', wait=False)
    await expect(panel).to_be_visible()
    for text in ['4,000', '2,000', '16,000', '600', '400']:
        await expect(panel.get_by_text(text, exact=True)).to_be_visible()
    box = await panel.bounding_box()
    assert box['x'] >= 0 and box['x'] + box['width'] <= page.viewport_size['width']
    if page.viewport_size['width'] >= 640:
        assert box['y'] >= (await header.bounding_box())['y'] + (await header.bounding_box())['height']
    else:
        assert box['y'] == 0 and box['height'] == page.viewport_size['height']
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    if page.viewport_size['width'] == 390:
        await page.screenshot(path='/tmp/branchline-api-costs-phone.png')
    await page.get_by_role('button', name='Close API costs', exact=True).click()
    await expect(panel).to_have_count(0)


async def agent_status_filters(page):
    tree = page.get_by_role('navigation', name='Session agent tree')
    filters = page.get_by_role('group', name='Agent status filter')
    active = filters.get_by_role('button', name='Show active agents', exact=True)
    done = filters.get_by_role('button', name='Show done agents', exact=True)
    all_agents = filters.get_by_role('button', name='Show all agents', exact=True)
    await expect(active).to_have_attribute('aria-pressed', 'true')
    usage = dict(inputTokens=100, outputTokens=100, cacheReadTokens=1000, cacheWriteTokens=0,
                 cacheWrite1hTokens=0, reasoningTokens=0, totalTokens=1200, costUSD=1.25)
    empty_usage = dict(usage, inputTokens=0, outputTokens=0, cacheReadTokens=0, totalTokens=0, costUSD=0)
    events = [
        dict(type='context_update', payload=dict(agent='Reviewer', tokens=100, usage=usage)),
        dict(type='context_update', payload=dict(agent='Implementer', tokens=100, usage=empty_usage)),
        dict(type='agent_complete', payload=dict(name='Reviewer')),
        dict(type='agent_complete', payload=dict(name='Implementer')),
        dict(type='agent_spawn', payload=dict(name='Test runner')),
    ]
    for i,event in enumerate(events):
        event.update(time=2+i/10, sessionId='phone-primary', eventId=1000+i, streamId='phone-fixture')
    await page.evaluate("events => window.postMessage({type:'agent-event-batch',events},'*')", events)
    await expect(tree.get_by_role('button', name='Monitor Reviewer', exact=True)).to_have_count(0)

    await expect(tree.get_by_role('button', name='Monitor Implementer', exact=True)).to_be_visible()
    await expect(tree.get_by_role('button', name='Monitor Test runner', exact=True)).to_be_visible()
    header = page.get_by_role('region', name='Agent controls')
    await expect(header).to_contain_text('~$1.25 API')
    await done.click()
    await expect(tree.get_by_role('button', name='Monitor Reviewer', exact=True)).to_be_visible()
    await expect(tree.get_by_role('button', name='Monitor Test runner', exact=True)).to_have_count(0)
    await tree.get_by_role('button', name='Monitor Reviewer', exact=True).click()
    await expect(page.get_by_role('region', name='Agent activity')).to_be_visible()
    await active.click()
    await expect(page.get_by_role('region', name='Agent activity')).to_have_count(0)
    await all_agents.click()
    await expect(tree.get_by_role('button', name='Monitor Reviewer', exact=True)).to_be_visible()
    await expect(tree.get_by_role('button', name='Monitor Test runner', exact=True)).to_be_visible()
    await expect(header).to_contain_text('~$1.25 API')
    for button in [active, done, all_agents]:
        box = await button.bounding_box()
        assert box['height'] >= 44
        assert box['x'] >= 0 and box['x'] + box['width'] <= page.viewport_size['width']
    await done.click()
    await page.reload(wait_until='domcontentloaded')
    await expect(done).to_have_attribute('aria-pressed', 'true')
    await expect(page.get_by_text('No done subagents.', exact=True)).to_be_visible()
    await expect(tree.get_by_role('button', name='Monitor main session', exact=True)).to_be_visible()
    await active.click()
    await expect(tree.get_by_role('button', name='Monitor Reviewer', exact=True)).to_be_visible()
    if page.viewport_size['width'] == 390:
        await page.screenshot(path='/tmp/branchline-agent-status-phone.png')


async def cost_tools(panel, tab='Spend', wait=True):
    """Exercise retained advanced tools through the new disclosures."""
    await panel.get_by_role('tab',name=tab,exact=True).click()
    if wait:
        await expect(panel.get_by_label('Chart headline',exact=True)).not_to_have_text('—')
    filters=panel.get_by_role('button',name='Cost filters',exact=True)
    if await filters.get_attribute('aria-expanded') == 'false':
        await filters.click()
    for label in ['Chart details','Cache reuse by agent','Session totals']:
        summary=panel.locator('summary').filter(has_text=re.compile('^'+re.escape(label)+'$'))
        if await summary.count() and not await summary.evaluate('element=>element.parentElement.open'):
            await summary.click()
    await panel.evaluate('element=>{element.scrollTop=0}')


async def cost_history_graph(page):
    requests = []
    async def history_route(route):
        sid = parse_qs(urlparse(route.request.url).query)['sessionId'][0]
        requests.append(sid)
        points = [dict(timestamp=1792490400000+i*3600000, costUSD=cost) for i,cost in enumerate([0.25, 0.75, 2.5])]
        if sid == 'phone-other': points = [dict(timestamp=1792490400000, costUSD=9.5)]
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId=sid, history=dict(
            points=points, untimedCostUSD=0, totalCostUSD=points[-1]['costUSD'], unpricedResponses=0))))
    await page.route('**/session-cost-history?*', history_route)
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs')
    await cost_tools(panel, tab='Spend')
    chart = panel.get_by_role('img', name='API cost over time', exact=True, include_hidden=True)
    await expect(chart).to_be_visible()
    readout = panel.get_by_label('Cost at selected time', exact=True)
    await expect(readout).to_contain_text('$2.50')
    slider = panel.get_by_role('slider', name='Inspect cost history', exact=True)
    await slider.fill('1')
    await expect(readout).to_contain_text('$0.75')
    await slider.press('End')
    await expect(readout).to_contain_text('$2.50')
    box = await chart.bounding_box()
    await chart.click(position=dict(x=box['width']*0.15, y=box['height']*0.5))
    await expect(readout).to_contain_text('$0.25')
    assert await slider.evaluate('element => element.getBoundingClientRect().height') >= 44
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    if page.viewport_size['width'] == 390:
        await page.screenshot(path='/tmp/branchline-cost-history-phone.png')
    await page.get_by_role('combobox', name='Main session').select_option('phone-other')
    await expect(readout).to_contain_text('$9.50')
    await page.get_by_role('button', name='Close API costs', exact=True).click()
    before = len(requests)
    await page.wait_for_timeout(5200)
    assert len(requests) == before, 'Closing the cost view must stop history requests'


async def cost_history_retry(page):
    attempts = []
    async def history_route(route):
        attempts.append(route.request.url)
        if len(attempts) == 1:
            await route.fulfill(status=503, body='Unavailable')
        else:
            await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId='phone-primary', history=dict(
                points=[], untimedCostUSD=2.5, totalCostUSD=2.5, unpricedResponses=0))))
    await page.route('**/session-cost-history?*', history_route)
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs')
    await panel.get_by_role('button', name='Retry cost history', exact=True).click()
    await expect(panel.get_by_text('No dated usage yet.', exact=True)).to_be_visible()
    await expect(panel.get_by_label('Chart headline',exact=True)).to_have_text('—')
    await expect(panel).to_contain_text('$2.50 has no recorded timestamp')
    await expect(panel.get_by_role('img', name='API cost over time', exact=True, include_hidden=True)).to_have_count(0)


async def cost_burn_breakdown(page):
    start = 1792490400000
    def parts(factor):
        return dict(input=0.2*factor, output=0.3*factor, cacheRead=0.4*factor, cacheWrite=0.1*factor, unattributed=0)
    points = [dict(timestamp=start+i*60000, costUSD=cost, breakdownUSD=parts(cost)) for i,cost in [(0,1),(1,3),(3,4)]]
    rates = [dict(timestamp=start+i*60000, costUSDPerMinute=cost, breakdownUSDPerMinute=parts(cost)) for i,cost in enumerate([1,2,0,1])]
    await page.route('**/session-cost-history?*', lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(
        sessionId='phone-primary', history=dict(points=points, burnRate=dict(bucketMs=60000, endTimestamp=start+240000-1, points=rates),
        untimedCostUSD=0, totalCostUSD=4, unpricedResponses=0)))))
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs')
    await cost_tools(panel, tab='Burn')
    await panel.get_by_role('combobox',name='Burn rate source',exact=True).select_option('all')
    rate = panel.get_by_role('img', name='API dollar burn rate', exact=True, include_hidden=True)
    await expect(rate).to_be_visible()
    await expect(panel).to_contain_text('1 min buckets')
    slider = panel.get_by_role('slider', name='Inspect cost history', exact=True)
    await slider.fill('1')
    await expect(panel.get_by_label('Cost at selected time', exact=True)).to_contain_text('$3.00')
    await expect(panel.get_by_label('Burn rate at selected time', exact=True)).to_contain_text('$120.00/hr')
    sources = panel.get_by_role('table', name='Cost and burn rate by source')
    await expect(sources.get_by_role('row', name=re.compile('Input'))).to_contain_text('$0.60')
    await expect(sources.get_by_role('row', name=re.compile('Input'))).to_contain_text('$24.00/hr')
    for name in ['Output', 'Cache read', 'Cache write']:
        await expect(sources.get_by_role('row', name=re.compile(name))).to_be_visible()
    overlay = panel.get_by_role('button', name='Cost breakdown', exact=True)
    await expect(overlay).to_have_attribute('aria-pressed', 'true')
    await overlay.click()
    await expect(panel.locator('[aria-label="Cost source overlay"]')).to_have_count(0)
    await expect(panel.locator('[aria-label="Burn rate source overlay"]')).to_have_count(0)
    await overlay.click()
    await expect(panel.locator('[aria-label="Cost source overlay"]')).to_have_count(1)
    await expect(panel.locator('[aria-label="Burn rate source overlay"]')).to_have_count(1)
    box = await rate.bounding_box()
    await rate.click(position=dict(x=box['width']*0.66, y=box['height']*0.5))
    await expect(panel.get_by_label('Burn rate at selected time', exact=True)).to_contain_text('$0.00/hr')
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    for control in [slider, overlay]:
        box = await control.bounding_box()
        assert box['height'] >= 44 and box['x'] >= 0 and box['x']+box['width'] <= page.viewport_size['width']
    if page.viewport_size['width'] == 390:
        await slider.fill('1')
        await panel.evaluate('element => {element.scrollTop = 0}')
        await page.screenshot(path='/tmp/branchline-burn-phone.png')


async def agent_model_settings(page):
    async def send(payloads, first_id):
        events = [dict(type='model_detected', payload=payload, time=4+i/10, sessionId='phone-primary', eventId=first_id+i, streamId='phone-fixture') for i,payload in enumerate(payloads)]
        await page.evaluate("events => window.postMessage({type:'agent-event-batch',events},'*')", events)
    await send([
        dict(agent='Orchestrator', model='claude-opus-5-5', reasoningEffort='xhigh'),
        dict(agent='Reviewer', model='claude-opus-5-5', reasoningEffort='high'),
        dict(agent='Implementer', model='gpt-6.1-sol', reasoningEffort='max'),
        dict(agent='Test runner', model='gpt-6.1-sol', reasoningEffort=None),
    ], 2000)
    tree = page.get_by_role('navigation', name='Session agent tree')
    await expect(tree.get_by_role('button', name='Monitor main session', exact=True)).to_contain_text('Opus 5.5 · xhigh')
    reviewer = tree.get_by_role('button', name='Monitor Reviewer', exact=True)
    await expect(reviewer).to_contain_text('Opus 5.5 · high')
    await expect(tree.get_by_role('button', name='Monitor Implementer', exact=True)).to_contain_text('GPT-6.1-sol · max')
    await expect(tree.get_by_role('button', name='Monitor Test runner', exact=True)).to_contain_text('effort unreported')
    await reviewer.click()
    details = page.get_by_role('region', name='Agent activity')
    await expect(details).to_contain_text('Model: claude-opus-5-5')
    await expect(details).to_contain_text('Reasoning: high')
    await send([dict(agent='Reviewer', model='claude-opus-5-5', reasoningEffort='xhigh')], 2100)
    await expect(details).to_contain_text('Reasoning: xhigh')
    await send([dict(agent='Reviewer', model='claude-opus-5-5', reasoningEffort=None)], 2200)
    await expect(details).to_contain_text('Reasoning: unreported')
    await send([dict(agent='Reviewer', model='gpt-6.1-sol', reasoningEffort='ultra')], 2300)
    await expect(details).to_contain_text('Model: gpt-6.1-sol')
    await expect(details).to_contain_text('Reasoning: ultra')
    for row in await tree.get_by_role('button').all():
        box = await row.bounding_box()
        assert box and box['height'] >= 44
        assert box['x'] >= 0 and box['x']+box['width'] <= page.viewport_size['width']
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    if page.viewport_size['width'] == 390:
        await page.screenshot(path='/tmp/branchline-model-settings-phone.png')
    await page.get_by_role('combobox', name='Main session').select_option('phone-other')
    await expect(tree.get_by_role('button', name='Monitor main session', exact=True)).to_contain_text('Model unreported')


async def cost_model_analytics(page):
    start = 1792490400000
    opus = '["claude-opus-5-5",null]'
    xhigh = '["claude-opus-5-5","xhigh"]'
    requests = []
    def group(key, model, effort, cost, records):
        return dict(id=key, model=model, reasoningEffort=effort, records=records, costUSD=cost, knownCostUSD=cost,
                    tokens=dict(inputTokens=1000, outputTokens=1000, cacheReadTokens=0, cacheWriteTokens=0, cacheWrite1hTokens=0, reasoningTokens=0),
                    totalTokens=2000, breakdownUSD=dict(input=cost, output=0, cacheRead=0, cacheWrite=0, unattributed=0), averageCostUSDPerMinute=cost/120)
    async def history_route(route):
        query = parse_qs(urlparse(route.request.url).query)
        requests.append(query)
        detailed = query.get('groupBy') == ['model-reasoning']
        groups = ([group(xhigh, 'claude-opus-5-5', 'xhigh', 4, 1),
                   group('["claude-opus-5-5","high"]', 'claude-opus-5-5', 'high', 2, 1)] if detailed
                  else [group(opus, 'claude-opus-5-5', None, 6, 2)])
        groups.append(group('["gpt-6.1-sol",null]', 'gpt-6.1-sol', None, 3, 1))
        selected = query.get('group', [None])[0]
        total = next((g['costUSD'] for g in groups if g['id'] == selected), 9)
        resolution = query.get('resolution', ['auto'])[0]
        ms = dict(minute=60000, hour=3600000, day=86400000).get(resolution, 60000)
        dated = [dict(timestamp=start, costUSD=total/2), dict(timestamp=start+ms, costUSD=total)]
        rates = [dict(timestamp=start+i*ms, costUSDPerMinute=total/2*60000/ms,
                      breakdownUSDPerMinute=dict(input=total/2*60000/ms, output=0, cacheRead=0, cacheWrite=0, unattributed=0)) for i in range(2)]
        window = dict(start=start, end=start+2*ms-1, latestEnd=start+2*ms-1, startCostUSD=0, startBreakdownUSD=dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0))
        history = dict(points=dated, groups=groups, group=selected, groupBy='model-reasoning' if detailed else 'model', resolution=resolution,
                       burnRate=dict(bucketMs=ms, endTimestamp=window['end'], points=rates), window=window,
                       untimedCostUSD=0, totalCostUSD=total, unpricedResponses=0)
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId='phone-primary', history=history)))
    await page.route('**/session-cost-history?*', history_route)
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs')
    await cost_tools(panel, tab='Spend')
    grouping = panel.get_by_role('combobox', name='Group costs by', exact=True)
    resolution = panel.get_by_role('combobox', name='Cost time resolution', exact=True)
    await expect(grouping).to_be_visible(timeout=3000)
    await expect(panel.get_by_role('button', name='Filter costs for Opus 5.5', exact=True)).to_contain_text('$6.00')
    await grouping.select_option('model-reasoning')
    selected = panel.get_by_role('button', name='Filter costs for Opus 5.5 · xhigh', exact=True)
    await expect(selected).to_contain_text('$4.00')
    await expect(selected).to_contain_text('2k tokens')
    await selected.click()
    await expect(selected).to_have_attribute('aria-pressed','true')
    await expect(panel.get_by_label('Cost at selected time', exact=True)).to_contain_text('$4.00')
    await resolution.select_option('hour')
    await expect(panel.get_by_label('Burn rate at selected time', exact=True)).to_contain_text('$2.00/hr')
    await expect(panel.get_by_role('table', name='Cost and burn rate by source')).to_contain_text('$/hr')
    await resolution.select_option('day')
    await expect(panel.get_by_label('Burn rate at selected time', exact=True)).to_contain_text('$2.00/day')
    total_view = panel.get_by_role('button', name='Show total cost history', exact=True)
    recent_view = panel.get_by_role('button', name='Show last 2 hours cost history', exact=True)
    await expect(total_view).to_have_attribute('aria-pressed', 'true')
    await recent_view.click()
    await expect(recent_view).to_have_attribute('aria-pressed', 'true')
    await expect(panel.get_by_label('Burn rate at selected time', exact=True)).to_contain_text('$2.00/day')
    assert requests[-1]['range'] == ['2h']
    await panel.get_by_role('button', name='Show costs for all models', exact=True).click()
    await expect(panel.get_by_label('Cost at selected time', exact=True)).to_contain_text('$9.00')
    assert requests[-1].get('group') is None
    await resolution.select_option('minute')
    await expect(panel.get_by_label('Burn rate at selected time', exact=True)).to_contain_text('$4.50/min')
    assert requests[-1]['resolution'] == ['minute']
    assert requests[-1]['groupBy'] == ['model-reasoning']
    assert requests[-1]['range'] == ['2h']
    await total_view.click()
    await expect(total_view).to_have_attribute('aria-pressed', 'true')
    await expect(panel.get_by_label('Cost at selected time', exact=True)).to_contain_text('$9.00')
    assert requests[-1]['range'] == ['total']
    panel_box = await panel.bounding_box()
    playback_box = await page.get_by_role('button', name=re.compile('Review$')).locator('..').bounding_box()
    if page.viewport_size['width'] >= 640:
        assert panel_box['y'] + panel_box['height'] <= playback_box['y'], 'Cost panel overlaps bottom playback controls'
    else:
        assert panel_box['y'] == 0 and panel_box['height'] == page.viewport_size['height']
    for control in [grouping, resolution, selected, total_view, recent_view]:
        box = await control.bounding_box()
        assert box and box['height'] >= 44 and box['x'] >= 0 and box['x']+box['width'] <= page.viewport_size['width']
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    if page.viewport_size['width'] == 390:
        await panel.evaluate('element => {element.scrollTop = 0}')
        await page.screenshot(path='/tmp/branchline-cost-analytics-phone.png')


async def cost_readable_layout(page):
    start = 1792490400000
    zero = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
    history = dict(points=[dict(timestamp=start,costUSD=1,breakdownUSD=dict(zero,input=1)),
                           dict(timestamp=start+3600000,costUSD=4,breakdownUSD=dict(zero,input=4))],
                   totalCostUSD=4,untimedCostUSD=0,unpricedResponses=0,groups=[],
                   burnRate=dict(bucketMs=60000,endTimestamp=start+3600000,points=[
                       dict(timestamp=start+i*60000,costUSDPerMinute=value,breakdownUSDPerMinute=dict(zero,input=value))
                       for i,value in enumerate([0.1,0.2,0.05,0.12]+[0.06]*56+[0.17])]))
    await page.route('**/session-cost-history?*', lambda route: route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(sessionId='phone-primary',history=history))))
    await page.get_by_role('button',name='$Cost',exact=True).click()
    panel = page.get_by_role('region',name='Session API costs')
    assert await panel.evaluate('element=>element.contains(document.activeElement)'), 'Focus must enter the cost view'
    await expect(panel.get_by_role('tab',name='Burn',exact=True)).to_have_attribute('aria-selected','true')
    await expect(panel.get_by_role('img')).to_have_count(1)
    await expect(panel.get_by_role('img',name='API dollar burn rate',exact=True, include_hidden=True)).to_be_visible()
    await expect(panel.get_by_role('combobox',name='Burn rate source',exact=True)).to_have_value('total')
    await expect(panel.get_by_role('combobox',name='Group costs by',exact=True)).to_have_count(0)
    await expect(panel.get_by_role('table',name='Cost and burn rate by source')).to_have_count(0)
    await expect(panel.get_by_role('region',name='Cache reuse',exact=True)).to_have_count(0)
    path = panel.get_by_role('img').locator('path[data-source="total"]')
    assert 'C' in await path.get_attribute('d')
    await panel.get_by_role('tab',name='Spend',exact=True).click()
    await expect(panel.get_by_role('img')).to_have_count(1)
    await expect(panel.get_by_role('img',name='API cost over time',exact=True, include_hidden=True)).to_be_visible()
    await panel.get_by_role('button',name='Cost filters',exact=True).click()
    await expect(panel.get_by_role('combobox',name='Group costs by',exact=True)).to_be_visible()
    await panel.get_by_role('button',name='Cost filters',exact=True).click()
    if page.viewport_size['width'] < 640:
        box=await panel.bounding_box()
        assert box['x']==0 and box['y']==0 and abs(box['height']-page.viewport_size['height'])<=1,box
    assert await panel.evaluate("element=>getComputedStyle(element).fontFamily.includes('sans')")
    for tab in await panel.get_by_role('tab').all():
        box=await tab.bounding_box()
        assert box['height']>=44
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    if page.viewport_size['width']==390:
        await panel.get_by_role('tab',name='Burn',exact=True).click()
        await page.screenshot(path='/tmp/branchline-readable-phone.png')
    await panel.get_by_role('button',name='Close API costs',exact=True).focus()
    if page.viewport_size['width'] < 640:
        await page.keyboard.press('Shift+Tab')
        assert await panel.evaluate('element=>element.contains(document.activeElement)')
    await page.keyboard.press('Escape')
    await expect(panel).to_have_count(0)
    await expect(page.get_by_role('button',name='$Cost',exact=True)).to_be_focused()


async def cost_burn_trends(page):
    hour = 3600000
    await page.clock.install()
    cutoff = await page.evaluate('new Date(2026,9,21,10,30).getTime()')
    midnight = await page.evaluate('new Date(2026,9,21).getTime()')
    await page.evaluate('value => { window.__burnNow = value; Date.now = () => window.__burnNow }', cutoff)
    rollover = asyncio.Event()
    rollover.set()
    zero = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
    opus = '["claude-opus-5-5",null]'
    codex = '["gpt-6.1-sol",null]'
    async def history_route(route):
        query = parse_qs(urlparse(route.request.url).query)
        selected = query.get('group', [''])[0]
        is_codex = selected == codex
        groups = [dict(id=key, model=model, records=2, tokens=dict(inputTokens=100, outputTokens=0,
                      cacheReadTokens=0 if is_codex else 1000, cacheWriteTokens=write, cacheWrite1hTokens=0, reasoningTokens=0),
                      totalTokens=1100+write, costUSD=20, knownCostUSD=20, breakdownUSD=zero, averageCostUSDPerMinute=0.1)
                  for key, model, write in [(opus, 'claude-opus-5-5', 1000), (codex, 'gpt-6.1-sol', 0)]]
        if query.get('fixedWindow') == ['true']:
            start, end = int(query['start'][0]), int(query['end'][0])
            if start > midnight:
                await rollover.wait()
            unit_cost = 2 if start == midnight else 4
            rates = [dict(timestamp=start+i*hour, costUSDPerMinute=unit_cost*(0.5 if i == 10 else 1)/60,
                          breakdownUSDPerMinute=dict(zero, input=unit_cost*(0.5 if i == 10 else 1)/60) if is_codex else
                          dict(zero, cacheWrite=unit_cost*(0.5 if i == 10 else 1)/60)) for i in range(11)]
            history = dict(points=[], totalCostUSD=21, unpricedResponses=0, untimedCostUSD=0, groups=groups,
                           window=dict(start=start, end=end, startCostUSD=0, startBreakdownUSD=zero),
                           burnRate=dict(bucketMs=hour, endTimestamp=end, points=rates))
        else:
            part = dict(zero, input=3, cacheWrite=1)
            history = dict(points=[dict(timestamp=midnight, costUSD=1, breakdownUSD=dict(zero,cacheWrite=1)),
                                   dict(timestamp=cutoff, costUSD=4, breakdownUSD=part)],
                           totalCostUSD=4, unpricedResponses=0, untimedCostUSD=0, groups=groups,
                           bounds=dict(start=midnight-hour*24, end=cutoff),
                           window=dict(start=midnight,end=cutoff,startCostUSD=0,startBreakdownUSD=zero),
                           burnRate=dict(bucketMs=hour,endTimestamp=cutoff,points=[
                               dict(timestamp=midnight+i*hour,costUSDPerMinute=1/60,
                                    breakdownUSDPerMinute=dict(zero,input=0.8/60,cacheWrite=0.2/60)) for i in range(11)]))
        await route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(sessionId='phone-primary',history=history)))
    await page.route('**/session-cost-history?*', history_route)
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs')
    await cost_tools(panel, tab='Burn')
    source = panel.get_by_role('combobox', name='Burn rate source', exact=True)
    await source.select_option('cacheWrite')
    chart = panel.get_by_role('img', name='API dollar burn rate', exact=True, include_hidden=True)
    await expect(chart.locator('path[data-source="cacheWrite"]')).to_have_count(1)
    box = await chart.bounding_box()
    assert box['height'] >= 190, box
    await panel.get_by_role('combobox', name='Burn rate view', exact=True).select_option('daily')
    daily = panel.get_by_role('region', name='Daily burn comparison', exact=True)
    await expect(daily).to_contain_text('50% lower')
    await expect(daily).to_contain_text('$21.00')
    await expect(daily).to_contain_text('$42.00')
    await expect(daily.get_by_role('img',name='Today and yesterday burn rate',exact=True)).to_be_visible()
    await expect(daily.locator('path[data-period="today"]')).to_have_attribute('data-scale-max','4')
    await expect(daily.locator('path[data-period="yesterday"]')).to_have_attribute('data-scale-max','4')
    if page.viewport_size['width'] == 390:
        await daily.scroll_into_view_if_needed()
        await page.screenshot(path='/tmp/branchline-burn-trends-phone.png')
    # The old day must not become "Today" when the next day's requests lag.
    rollover.clear()
    try:
        await page.evaluate('value => { window.__burnNow = value }', midnight+24*hour+120000)
        await page.clock.fast_forward(60000)
        await expect(daily).to_contain_text('Loading both days')
        await expect(daily.get_by_role('img')).to_have_count(0)
    finally:
        rollover.set()
    await expect(daily.get_by_role('img')).to_be_visible()
    await panel.get_by_role('button',name='Filter costs for GPT-6.1-sol',exact=True).click()
    await expect(daily).to_contain_text('Cache-write burn is unknown')
    await expect(daily.get_by_role('img')).to_have_count(0)
    await expect(panel.get_by_role('region',name='Cache write data unavailable')).to_be_visible()
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    for control in [source, panel.get_by_role('combobox', name='Burn rate view', exact=True)]:
        box = await control.bounding_box()
        assert box and box['height'] >= 44


async def cost_cache_reuse(page):
    end = 1792584000000
    zero = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
    def counts(input, read, write=0):
        return dict(inputTokens=input, cacheReadTokens=read, cacheWriteTokens=write,
                    cacheWrite1hTokens=0, outputTokens=0, reasoningTokens=0)
    async def history_route(route):
        query = parse_qs(urlparse(route.request.url).query)
        recent = query.get('range', ['total'])[0] == '1h'
        selected = query.get('group', [''])[0]
        groups = [dict(id=json.dumps([model, None], separators=(',', ':')), model=model,
                       records=2, tokens=counts(1000, 9000), totalTokens=10000,
                       costUSD=2, knownCostUSD=2, breakdownUSD=zero, averageCostUSDPerMinute=0.1)
                  for model in ['gpt-6.1-sol', 'claude-opus-5-5']]
        event = dict(timestamp=end, model='gpt-6.1-sol', reasoningEffort='max', gapMs=34560000,
                     cacheHitPercent=3.6, previousCacheHitPercent=99.3, uncachedInputTokens=325090,
                     cacheReadTokens=12032, cacheWriteTokens=0, inputCostUSD=1.30036, cacheWriteCostUSD=0)
        review = dict(agentId='review', agentName='Review phone controls with a very long descriptive agent name',
                      records=2, uncachedInputTokens=325100, cacheReadTokens=22000, cacheWriteTokens=0,
                      cacheHitPercent=6.3, inputCostUSD=1.31, knownInputCostUSD=1.31,
                      cacheWriteCostUSD=0, cacheWritesUnknown=True, longGapRecords=1,
                      afterLongGapInputCostUSD=1.30036, knownAfterLongGapInputCostUSD=1.30036,
                      costliest=[event], afterLongGaps=[event])
        main = dict(review, agentId='main', agentName='Main session', records=1, uncachedInputTokens=100,
                    inputCostUSD=0.1, knownInputCostUSD=0.1, cacheWriteTokens=100000,
                    cacheWriteCostUSD=0.5, cacheWritesUnknown=False, longGapRecords=0,
                    afterLongGapInputCostUSD=0, knownAfterLongGapInputCostUSD=0,
                    costliest=[dict(event, model='claude-opus-5-5', gapMs=None, previousCacheHitPercent=None,
                                   inputCostUSD=0.1, uncachedInputTokens=100, cacheWriteTokens=100000, cacheWriteCostUSD=0.5)],
                    afterLongGaps=[])
        agents = [review, main] + [dict(main, agentId=f'other-{i}', agentName=f'Other reviewer {i}') for i in range(10)]
        if selected == groups[0]['id']:
            agents = [review]
        elif selected == groups[1]['id']:
            agents = [main]
        if recent:
            agents = [dict(agent, inputCostUSD=0.2, knownInputCostUSD=0.2) for agent in agents]
        history = dict(points=[dict(timestamp=end, costUSD=4, breakdownUSD=dict(zero, input=4))],
                       totalCostUSD=4, untimedCostUSD=0, unpricedResponses=0, groups=groups,
                       burnRate=dict(bucketMs=60000, points=[]), bounds=dict(start=end-86400000, end=end),
                       window=dict(start=end-3600000 if recent else end-86400000, end=end,
                                   startCostUSD=0, startBreakdownUSD=zero),
                       cacheReuse=dict(longGapMs=600000, agents=agents, undatedRecords=1, missingTokenRecords=0))
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId='phone-primary', history=history)))
    await page.route('**/session-cost-history?*', history_route)
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs')
    await cost_tools(panel, tab='Spend')
    reuse = panel.get_by_role('region', name='Cache reuse', exact=True)
    await expect(reuse).to_be_visible()
    await expect(reuse.get_by_role('group')).to_have_count(10)
    await reuse.get_by_role('button', name='Show more agents in cache reuse', exact=True).click()
    await expect(reuse.get_by_role('group')).to_have_count(12)
    await expect(panel.get_by_role('region', name='Cache write data unavailable')).to_be_visible()
    await expect(reuse.get_by_role('group', name='Cache reuse for Main session', exact=True)).to_contain_text('$0.50')
    review = reuse.get_by_role('group', name='Cache reuse for Review phone controls with a very long descriptive agent name', exact=True)
    await review.locator('summary').click()
    await expect(review).to_contain_text('99.3% → 3.6%')
    await expect(review).to_contain_text('9h 36m')
    await expect(review).to_contain_text('325,090')
    await expect(review).to_contain_text('$1.30')
    await expect(review).to_contain_text('Unknown')
    await reuse.get_by_role('combobox', name='Cache reuse records', exact=True).select_option('after-gap')
    await expect(reuse.get_by_role('group', name='Cache reuse for Main session', exact=True)).to_have_count(0)
    if page.viewport_size['width'] == 390:
        await reuse.scroll_into_view_if_needed()
        await page.screenshot(path='/tmp/branchline-cache-reuse-phone.png')
    await reuse.get_by_role('combobox', name='Cache reuse records', exact=True).select_option('costliest')
    await panel.get_by_role('button', name='Filter costs for Opus 5.5', exact=True).click()
    await expect(review).to_have_count(0)
    await expect(reuse).to_contain_text('Main session')
    await expect(panel.get_by_role('region', name='Cache write data unavailable')).to_have_count(0)
    await panel.get_by_role('button', name='Show last hour cost history', exact=True).click()
    await expect(reuse).to_contain_text('$0.20')
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    for control in await reuse.get_by_role('combobox').all() + await reuse.locator('summary').all():
        box = await control.bounding_box()
        assert box and box['height'] >= 44


async def cost_cache_write_unknown(page):
    first, latest = 1790812800000, 1790812800000 + 7200000
    sol = '["gpt-6.1-sol",null]'
    max_effort = '["gpt-6.1-sol","max"]'
    opus = '["claude-opus-5-5",null]'
    zero = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)

    def group(key, model, tokens, input_cost, write_cost=0):
        return dict(id=key, model=model, reasoningEffort='max' if key == max_effort else None,
                    records=20, costUSD=input_cost+write_cost+1, knownCostUSD=input_cost+write_cost+1,
                    tokens=dict(inputTokens=tokens, outputTokens=0, cacheReadTokens=8000000,
                                cacheWriteTokens=100000 if write_cost else 0, cacheWrite1hTokens=0, reasoningTokens=0),
                    totalTokens=tokens+8000000, averageCostUSDPerMinute=1,
                    breakdownUSD=dict(zero, input=input_cost, cacheRead=1, cacheWrite=write_cost))

    async def history_route(route):
        query = parse_qs(urlparse(route.request.url).query)
        detailed = query.get('groupBy') == ['model-reasoning']
        key = max_effort if detailed else sol
        groups = [group(key, 'gpt-6.1-sol', 5000000, 12), group(opus, 'claude-opus-5-5', 1000, 1, .5)]
        selected = query.get('group', [None])[0]
        visible = [item for item in groups if not selected or selected == item['id']]
        total = sum(item['costUSD'] for item in visible)
        breakdown = {key: sum(item['breakdownUSD'][key] for item in visible) for key in zero}
        history = dict(groups=groups, groupBy='model-reasoning' if detailed else 'model', range=query.get('range', ['total'])[0],
                       points=[dict(timestamp=first, costUSD=0, breakdownUSD=zero), dict(timestamp=latest, costUSD=total, breakdownUSD=breakdown)],
                       totalCostUSD=total, untimedCostUSD=0, unpricedResponses=0, bounds=dict(start=first, end=latest),
                       window=dict(start=first, end=latest, startCostUSD=0, startBreakdownUSD=zero),
                       burnRate=dict(bucketMs=7200000, endTimestamp=latest, points=[]))
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId='phone-primary', history=history)))

    await page.route('**/session-cost-history?*', history_route)
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs')
    await cost_tools(panel, tab='Spend')
    unknown = panel.get_by_role('region', name='Cache write data unavailable', exact=True)
    await expect(unknown).to_be_visible()
    await expect(unknown).to_contain_text('Cache writes: Unknown')
    await expect(panel.get_by_role('region', name='Estimated cache writes', exact=True)).to_have_count(0)
    row = panel.get_by_role('table', name='Cost and burn rate by source').get_by_role('row').filter(has=page.get_by_role('rowheader', name='Cache write', exact=True))
    await expect(row.get_by_role('cell').nth(0)).to_have_text('Unknown')
    await expect(row.get_by_role('cell').nth(1)).to_have_text('Unknown')
    await expect(panel.get_by_label('Cost at selected time', exact=True)).to_have_text('$15.50')
    await panel.get_by_role('button', name='Show last hour cost history', exact=True).click()
    await expect(unknown).to_be_visible()
    await panel.get_by_role('button', name='Filter costs for Opus 5.5', exact=True).click()
    await expect(unknown).to_have_count(0)
    await expect(row.get_by_role('cell').nth(0)).to_have_text('$0.50')
    await panel.get_by_role('button', name='Show costs for all models', exact=True).click()
    await expect(unknown).to_be_visible()
    await panel.get_by_role('combobox', name='Group costs by', exact=True).select_option('model-reasoning')
    await panel.get_by_role('button', name='Filter costs for GPT-6.1-sol · max', exact=True).click()
    await expect(unknown).to_be_visible()
    await expect(row.get_by_role('cell').nth(0)).to_have_text('Unknown')
    box = await unknown.bounding_box()
    assert box and box['x'] >= 0 and box['x']+box['width'] <= page.viewport_size['width']
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')


async def cost_time_views(page):
    first = 1790812800000  # Oct 1, 2026 UTC
    end = first + 20 * 86400000
    requests = []
    async def history_route(route):
        query = parse_qs(urlparse(route.request.url).query)
        requests.append(query)
        view = query.get('range', ['total'])[0]
        start = end - {'1h':3600000,'2h':7200000}[view] if view in ['1h','2h'] else first
        baseline = 1 if view != 'total' else 0
        zero = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
        def point(timestamp,cost):
            return dict(timestamp=timestamp,costUSD=cost,breakdownUSD=dict(zero,unattributed=cost))
        history = dict(points=[point(start,baseline),point(end,4)],groups=[],range=view,
                       totalCostUSD=4,untimedCostUSD=0,unpricedResponses=0,
                       window=dict(start=start,end=end,startCostUSD=baseline,startBreakdownUSD=dict(zero,unattributed=baseline)),
                       burnRate=dict(bucketMs=end-start,endTimestamp=end,points=[dict(timestamp=start,costUSDPerMinute=(4-baseline)*60000/(end-start),breakdownUSDPerMinute=dict(zero,unattributed=(4-baseline)*60000/(end-start)))]))
        await route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(sessionId='phone-primary',history=history)))
    await page.route('**/session-cost-history?*',history_route)
    await page.get_by_role('button',name='$Cost',exact=True).click()
    panel = page.get_by_role('region',name='Session API costs')
    await cost_tools(panel, tab='Spend')
    total = panel.get_by_role('button',name='Show total cost history',exact=True)
    hour = panel.get_by_role('button',name='Show last hour cost history',exact=True)
    two_hours = panel.get_by_role('button',name='Show last 2 hours cost history',exact=True)
    resolution = panel.get_by_role('combobox',name='Cost time resolution',exact=True)
    description = panel.get_by_role('img',name='API cost over time',exact=True, include_hidden=True).locator('desc')
    async def expect_start(timestamp):
        label = await page.evaluate("timestamp => new Date(timestamp).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})",timestamp)
        await expect(description).to_contain_text(label)
    await expect(total).to_be_visible(timeout=3000)
    await expect(total).to_have_attribute('aria-pressed','true')
    await expect_start(first)
    for choice in ['day','minute']:
        await resolution.select_option(choice)
        await expect_start(first)
        assert requests[-1]['range']==['total']
    await two_hours.click()
    await expect_start(end-7200000)
    await resolution.select_option('hour')
    await expect_start(end-7200000)
    await expect(two_hours).to_have_attribute('aria-pressed','true')
    await hour.click()
    await expect_start(end-3600000)
    await resolution.select_option('day')
    await expect_start(end-3600000)
    await total.click()
    await expect_start(first)
    await resolution.select_option('minute')
    await expect_start(first)
    await expect(total).to_have_attribute('aria-pressed','true')
    assert requests[-1]['range']==['total']
    assert all('before' not in query for query in requests)
    await expect(panel.get_by_role('button',name='Earlier cost history',exact=True)).to_have_count(0)
    for button in [total,hour,two_hours]:
        box=await button.bounding_box()
        assert box and box['height']>=44 and box['x']>=0 and box['x']+box['width']<=page.viewport_size['width']
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    if page.viewport_size['width']==390:
        await panel.evaluate('element => {element.scrollTop=0}')
        await page.screenshot(path='/tmp/branchline-time-views-phone.png')


async def cost_phone_gestures(page):
    first = 1790812800000
    latest = first + 20 * 86400000
    requests = []
    held_response = []
    zero = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
    async def history_route(route):
        query = parse_qs(urlparse(route.request.url).query)
        requests.append(query)
        view = query.get('range', ['total'])[0]
        end = float(query['end'][0]) if view == 'window' else latest
        start = (float(query['start'][0]) if view == 'window' else
                 end - float(query['hours'][0]) * 3600000 if view == 'custom' else
                 end - {'1h':3600000,'2h':7200000}[view] if view in ['1h','2h'] else first)
        baseline = max(0, (start-first)/86400000)
        def point(timestamp, cost):
            return dict(timestamp=timestamp,costUSD=cost,breakdownUSD=dict(zero,input=cost))
        # Use attributed usage so selecting zero does not add/remove the
        # optional Unattributed row while measuring the chart's layout.
        history = dict(points=[point(start,baseline),point(end,max(0,(end-first)/86400000))],groups=[],range=view,
                       totalCostUSD=20,untimedCostUSD=0,unpricedResponses=0,bounds=dict(start=first,end=latest),
                       window=dict(start=start,end=end,startCostUSD=baseline,startBreakdownUSD=dict(zero,input=baseline)),
                       burnRate=dict(bucketMs=3600000,endTimestamp=end,points=[dict(timestamp=start,costUSDPerMinute=1/1440,breakdownUSDPerMinute=dict(zero,input=1/1440))]))
        if held_response:
            arrived, release = held_response.pop()
            arrived.set()
            await release.wait()
        await route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(sessionId='phone-primary',history=history)))
    await page.route('**/session-cost-history?*',history_route)
    await page.get_by_role('button',name='$Cost',exact=True).click()
    panel = page.get_by_role('region',name='Session API costs')
    await cost_tools(panel, tab='Spend')
    hours = panel.get_by_role('spinbutton',name='Last hours',exact=True)
    await expect(hours).to_be_visible()
    await hours.fill('3.5')
    await panel.get_by_role('button',name='Apply last hours',exact=True).click()
    cost = panel.get_by_role('img',name='API cost over time',exact=True, include_hidden=True)
    burn = panel.get_by_role('img',name='API dollar burn rate',exact=True, include_hidden=True)
    await expect(cost).to_have_attribute('data-window-start',str(latest-12600000))
    assert requests[-1]['range']==['custom'] and requests[-1]['hours']==['3.5']
    await panel.get_by_role('combobox',name='Cost time resolution',exact=True).select_option('day')
    await expect(cost).to_have_attribute('data-window-start',str(latest-12600000))
    total = panel.get_by_role('button',name='Show total cost history',exact=True)
    await total.click()
    await expect(cost).to_have_attribute('data-window-start',str(first))
    await expect(total).to_have_attribute('aria-pressed','true')
    await cost.scroll_into_view_if_needed()

    async def delayed_range(action, expected_window=None):
        # Hold the real request open: a fast fixture response used to hide the
        # SVG removal, collapsed panel and lost gesture preview on release.
        arrived, release = asyncio.Event(), asyncio.Event()
        held_response.append((arrived, release))
        await panel.evaluate('''element => {
            const plots = [...element.querySelectorAll('svg[role="img"]')];
            window.__heldCostPlots = {plots, removed: false, scrollTop: element.scrollTop,
              height: element.scrollHeight, boxes: plots.map(plot => plot.getBoundingClientRect().toJSON()),
              drawn: plots.map(plot => !!plot.querySelector('path[stroke]')?.getAttribute('d')),
              paragraphs: [...element.querySelectorAll('p')].map(p => ({text: p.textContent, height: p.getBoundingClientRect().height}))};
            window.__heldCostObserver = new MutationObserver(records => {
              for (const record of records) for (const node of record.removedNodes)
                if (plots.some(plot => node === plot || node.contains?.(plot))) window.__heldCostPlots.removed = true;
            });
            window.__heldCostObserver.observe(element, {childList: true, subtree: true});
        }''')
        async def stable_plots(keep_preview=False):
            result = await panel.evaluate('''element => {
                const held = window.__heldCostPlots;
                const current = [...element.querySelectorAll('svg[role="img"]')];
                return {mounted: held.plots.every((plot, index) => plot.isConnected && plot === current[index]),
                  removed: held.removed, scrollDelta: Math.abs(element.scrollTop-held.scrollTop),
                  heightDelta: Math.abs(element.scrollHeight-held.height),
                  cleared: held.drawn.some((drawn, index) => drawn && !current[index]?.querySelector('path[stroke]')?.getAttribute('d')),
                  hidden: current.some(plot => { const style = getComputedStyle(plot); return style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0'; }),
                  changedParagraphs: [...element.querySelectorAll('p')].flatMap((p, index) => {
                    const height = p.getBoundingClientRect().height, before = held.paragraphs[index];
                    return before && Math.abs(height-before.height)>1 ? [{before, after: {text:p.textContent, height}}] : [];
                  }),
                  moved: held.plots.some((plot, index) => Math.abs(plot.getBoundingClientRect().y-held.boxes[index].y)>1)};
            }''')
            assert result['mounted'] and not result['removed'], f'Range refresh detached a plot: {result}'
            assert not result['hidden'] and (not keep_preview or not result['cleared']), f'Range refresh hid the plotted preview: {result}'
            assert result['scrollDelta'] <= 1 and result['heightDelta'] <= 1 and not result['moved'], f'Range refresh moved the chart: {result}'
        try:
            await action()
            await asyncio.wait_for(arrived.wait(), timeout=3)
            # Wait for the release event's React update to paint while the
            # response is still blocked, without relying on a network delay.
            await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
            await stable_plots(keep_preview=expected_window is not None)
            if expected_window:
                for plot in [cost, burn]:
                    for edge, value in zip(['start', 'end'], expected_window):
                        actual = float(await plot.get_attribute(f'data-window-{edge}'))
                        assert abs(actual-value) <= 1, f'Committed {edge} jumped away from the gesture preview: {actual} != {value}'
            await expect(panel.get_by_text('Loading cost history…', exact=True)).to_be_visible()
            async with page.expect_response(lambda response: '/session-cost-history?' in response.url):
                release.set()
            await expect(panel.get_by_text('Loading cost history…', exact=True)).to_have_count(0)
            await stable_plots()
        finally:
            release.set()
            held_response.clear()
            await page.evaluate('window.__heldCostObserver.disconnect()')

    if page.viewport_size['width'] < 640:
        cdp = await page.context.new_cdp_session(page)
        async def touches(kind, points):
            await cdp.send('Input.dispatchTouchEvent',dict(type=kind,touchPoints=[dict(x=x,y=y,id=i,radiusX=3,radiusY=3) for i,x,y in points]))
        box = await cost.bounding_box()
        cx = box['x'] + box['width'] * 167/300
        cy = box['y'] + box['height'] * .42
        width = box['width'] * 250/300
        before = len([q for q in requests if q.get('range')==['window']])
        await touches('touchStart',[(1,cx-25,cy),(2,cx+25,cy)])
        for delta in [30,35,40,45,50]:
            await touches('touchMove',[(1,cx-delta,cy),(2,cx+delta,cy)])
        assert len([q for q in requests if q.get('range')==['window']])==before, 'Fetch only when the gesture ends'
        await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        preview = [float(await cost.get_attribute(f'data-window-{edge}')) for edge in ['start', 'end']]
        await delayed_range(lambda: touches('touchEnd',[]), preview)
        query = requests[-1]
        # Fractional touch coordinates vary by tiny subpixel amounts across widths.
        # A quarter second over this ten-day view is still far below one pixel.
        assert abs(float(query['start'][0])-(first+5*86400000)) < 250, query
        assert abs(float(query['end'][0])-(first+15*86400000)) < 250, query
        await expect(cost).to_have_attribute('data-window-start',query['start'][0])
        await expect(burn).to_have_attribute('data-window-start',query['start'][0])
        await expect(cost).to_have_attribute('data-window-end',query['end'][0])
        assert len([q for q in requests if q.get('range')==['window']])==before+1
        await expect(total).to_have_attribute('aria-pressed','false')
        # Dragging right moves to earlier usage, preserving the zoom span.
        await cost.scroll_into_view_if_needed()
        if os.environ.get('PHONE_CHECK_TRACEBACK'):
            await page.evaluate("""() => { window.__chartPointers=[]; for(const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) document.addEventListener(type,event=>{const svg=event.target.closest?.('svg');window.__chartPointers.push({type,id:event.pointerId,x:event.clientX,y:event.clientY,label:svg?.getAttribute('aria-label')});},true); }""")
        box = await cost.bounding_box()
        cx, cy = box['x']+box['width']*.5, box['y']+box['height']*.42
        await touches('touchStart',[(1,cx,cy)])
        for delta in [.05,.1,.15,.2]:
            await touches('touchMove',[(1,cx+width*delta,cy)])
        await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
        preview = [float(await cost.get_attribute(f'data-window-{edge}')) for edge in ['start', 'end']]
        await delayed_range(lambda: touches('touchEnd',[]), preview)
        query = requests[-1]
        start, end = float(query['start'][0]),float(query['end'][0])
        assert abs(start-(first+3*86400000)) < 250, query
        assert abs(end-start-10*86400000) < 250, query
        await expect(cost).to_have_attribute('data-window-start',query['start'][0])
        await expect(burn).to_have_attribute('data-window-end',query['end'][0])
        # Native vertical scrolling must cancel the pending chart gesture.
        await cost.scroll_into_view_if_needed()
        box = await cost.bounding_box()
        cx, cy = box['x']+box['width']*.5, box['y']+box['height']*.4
        previous = await panel.evaluate('element => element.scrollTop')
        before = len([q for q in requests if q.get('range')==['window']])
        await touches('touchStart',[(1,cx,cy)])
        for dy in [-15,-30,-50,-70]:
            await touches('touchMove',[(1,cx,cy+dy)])
        await touches('touchEnd',[])
        await expect(cost).to_have_attribute('data-window-start',query['start'][0])
        assert len([q for q in requests if q.get('range')==['window']])==before
        assert await panel.evaluate('element => element.scrollTop') > previous, 'Vertical chart swipe should scroll the panel'
        # A touch cancellation restores the range without fetching it.
        await cost.scroll_into_view_if_needed()
        box = await cost.bounding_box()
        cx,cy=box['x']+box['width']*.5,box['y']+box['height']*.4
        await touches('touchStart',[(1,cx,cy)])
        await touches('touchMove',[(1,cx+30,cy)])
        await touches('touchCancel',[])
        await expect(cost).to_have_attribute('data-window-start',query['start'][0])
        assert len([q for q in requests if q.get('range')==['window']])==before
        # Pinching out to the full bounds normalizes the request to Total.
        # Releasing must retain that full preview while Total is still loading.
        await touches('touchStart',[(1,cx-50,cy),(2,cx+50,cy)])
        for delta in [40,30,25,20]:
            await touches('touchMove',[(1,cx-delta,cy),(2,cx+delta,cy)])
        await expect(cost).to_have_attribute('data-window-start',str(first))
        await expect(cost).to_have_attribute('data-window-end',str(latest))
        await delayed_range(lambda: touches('touchEnd',[]), [first, latest])
        assert requests[-1]['range']==['total'] and 'start' not in requests[-1] and 'end' not in requests[-1]
        await expect(total).to_have_attribute('aria-pressed','true')
        await cdp.detach()
    else:
        await cost.focus()
        await page.keyboard.press('+')
        await expect(cost).to_have_attribute('data-window-start',str(first+5*86400000))
        await page.keyboard.press('ArrowRight')
        await expect(cost).to_have_attribute('data-window-start',str(first+7.5*86400000).replace('.0',''))
        await expect(panel.get_by_role('region',name='Cost history')).to_have_attribute('aria-busy','false')
        await delayed_range(lambda: cost.press('-'), [first, latest])
        assert requests[-1]['range']==['total'] and 'start' not in requests[-1] and 'end' not in requests[-1]
        await expect(total).to_have_attribute('aria-pressed','true')
    # Load a window again so the Total preset still exercises a new request.
    await cost.press('+')
    await expect(cost).to_have_attribute('data-window-start',str(first+5*86400000))
    await expect(panel.get_by_role('region',name='Cost history')).to_have_attribute('aria-busy','false')
    # Center the button clear of the sticky header before recording the
    # pending-request geometry; browser click scrolling is not a data redraw.
    await total.evaluate("element => element.scrollIntoView({block:'center', inline:'nearest'})")
    await delayed_range(lambda: total.click())
    await expect(cost).to_have_attribute('data-window-start',str(first))
    await expect(burn).to_have_attribute('data-window-end',str(latest))
    assert requests[-1]['range']==['total'] and 'start' not in requests[-1] and 'hours' not in requests[-1]
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    for control in [hours,panel.get_by_role('button',name='Apply last hours',exact=True)]:
        box=await control.bounding_box()
        assert box and box['height']>=44 and box['x']>=0 and box['x']+box['width']<=page.viewport_size['width']
    if page.viewport_size['width']==390:
        await hours.fill('3.5')
        await delayed_range(lambda: panel.get_by_role('button',name='Apply last hours',exact=True).click())
        await expect(cost).to_have_attribute('data-window-start',str(latest-12600000))
        await cost.scroll_into_view_if_needed()
        await page.screenshot(path='/tmp/branchline-gesture-phone.png')


async def cost_history_pending_queries(page):
    first, latest = 1790812800000, 1790812800000 + 20 * 86400000
    model = '["claude-opus-5-5",null]'
    zero = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
    pending = []
    gates = []
    await page.clock.install()

    async def history_route(route):
        query = parse_qs(urlparse(route.request.url).query)
        gate = pending.pop(0) if pending else None
        if gate:
            gate['query'] = query
            gate['arrived'].set()
            await gate['release'].wait()
        try:
            if gate and gate.get('fail'):
                await route.fulfill(status=503, body='temporarily unavailable')
                return
            session = query['sessionId'][0]
            view = query.get('range', ['total'])[0]
            end = int(query['end'][0]) if view == 'window' else latest
            start = int(query['start'][0]) if view == 'window' else latest - {'1h':3600000, '2h':7200000, 'custom':10800000}.get(view, latest-first)
            total = 9 if session == 'phone-other' else 2 if query.get('group') else 4
            bucket = {'hour':3600000, 'day':86400000}.get(query.get('resolution', ['auto'])[0], 60000)
            group = dict(id=model, model='claude-opus-5-5', records=2, costUSD=2, knownCostUSD=2,
                         tokens=dict(inputTokens=1000, outputTokens=1000, cacheReadTokens=0, cacheWriteTokens=0, cacheWrite1hTokens=0, reasoningTokens=0),
                         totalTokens=2000, breakdownUSD=dict(zero, unattributed=2), averageCostUSDPerMinute=.1)
            history = dict(points=[dict(timestamp=start, costUSD=0, breakdownUSD=zero),
                                   dict(timestamp=end, costUSD=total, breakdownUSD=dict(zero, unattributed=total))],
                           groups=[group], range=view, totalCostUSD=total, untimedCostUSD=0, unpricedResponses=0,
                           bounds=dict(start=first, end=latest), window=dict(start=start, end=end, startCostUSD=0, startBreakdownUSD=zero),
                           burnRate=dict(bucketMs=bucket, endTimestamp=end, points=[dict(timestamp=end-bucket+1,
                             costUSDPerMinute=total*60000/bucket, breakdownUSDPerMinute=dict(zero, unattributed=total*60000/bucket))]))
            await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId=session, history=history)))
        finally:
            if gate:
                gate['done'].set()

    async def hold(action, fail=False):
        gate = dict(arrived=asyncio.Event(), release=asyncio.Event(), done=asyncio.Event(), fail=fail)
        pending.append(gate)
        gates.append(gate)
        await action()
        await asyncio.wait_for(gate['arrived'].wait(), timeout=3)
        return gate

    async def complete(gate):
        gate['release'].set()
        await asyncio.wait_for(gate['done'].wait(), timeout=3)

    try:
        await page.route('**/session-cost-history?*', history_route)
        await page.get_by_role('button', name='$Cost', exact=True).click()
        panel = page.get_by_role('region', name='Session API costs')
        await cost_tools(panel, tab='Spend')
        cost = panel.get_by_role('img', name='API cost over time', exact=True, include_hidden=True)
        burn = panel.get_by_role('img', name='API dollar burn rate', exact=True, include_hidden=True)
        value = panel.get_by_label('Cost at selected time', exact=True)
        await expect(value).to_have_text('$4.00')
        original_cost, original_burn = await cost.element_handle(), await burn.element_handle()
        old = await hold(lambda: panel.get_by_role('button', name='Show last hour cost history', exact=True).click())
        assert await original_cost.evaluate('element => element.isConnected'), 'Range fetch removed the previous cost plot'
        assert await original_burn.evaluate('element => element.isConnected'), 'Range fetch removed the previous burn plot'
        await expect(panel.get_by_role('region', name='Cost history')).to_have_attribute('aria-busy', 'true')
        latest_query = await hold(lambda: panel.get_by_role('button', name='Show last 2 hours cost history', exact=True).click())
        await complete(latest_query)
        await expect(cost).to_have_attribute('data-window-start', str(latest-7200000))
        await complete(old)
        await expect(cost).to_have_attribute('data-window-start', str(latest-7200000))
        assert await original_cost.evaluate('element => element.isConnected'), 'A superseded reply replaced the plot'

        # A second gesture can restore the loaded interval while its zoom is
        # still pending; comparing commits only with the loaded data drops it.
        zoom = await hold(lambda: cost.press('+'))
        await expect(cost).to_have_attribute('data-window-start', str(latest-5400000))
        restore = await hold(lambda: cost.press('-'))
        await expect(cost).to_have_attribute('data-window-start', str(latest-7200000))
        await complete(restore)
        await expect(panel.get_by_role('region', name='Cost history')).to_have_attribute('aria-busy', 'false')
        await complete(zoom)
        await expect(cost).to_have_attribute('data-window-start', str(latest-7200000))

        # A loaded zoomed window can expand to the complete bounds. The
        # normalized Total request must keep those bounds pending its response.
        total = panel.get_by_role('button', name='Show total cost history', exact=True)
        await total.click()
        await expect(cost).to_have_attribute('data-window-start', str(first))
        await expect(panel.get_by_role('region', name='Cost history')).to_have_attribute('aria-busy', 'false')
        await cost.press('+')
        await expect(cost).to_have_attribute('data-window-start', str(first+5*86400000))
        await expect(panel.get_by_role('region', name='Cost history')).to_have_attribute('aria-busy', 'false')
        full = await hold(lambda: cost.press('-'))
        assert full['query']['range'] == ['total'] and 'start' not in full['query'] and 'end' not in full['query']
        for plot in [cost, burn]:
            await expect(plot).to_have_attribute('data-window-start', str(first))
            await expect(plot).to_have_attribute('data-window-end', str(latest))
        assert await original_cost.evaluate('element => element.isConnected'), 'Full-bounds zoom removed the previous cost plot'
        assert await original_burn.evaluate('element => element.isConnected'), 'Full-bounds zoom removed the previous burn plot'
        await expect(total).to_have_attribute('aria-pressed', 'true')
        await complete(full)
        await expect(panel.get_by_role('region', name='Cost history')).to_have_attribute('aria-busy', 'false')
        await expect(cost).to_have_attribute('data-window-start', str(first))
        await expect(burn).to_have_attribute('data-window-end', str(latest))

        # Failed range requests retain usable plots; Retry replaces their data.
        await panel.get_by_role('spinbutton', name='Last hours', exact=True).fill('3')
        failed = await hold(lambda: panel.get_by_role('button', name='Apply last hours', exact=True).click(), fail=True)
        await complete(failed)
        await expect(panel.get_by_role('button', name='Retry cost history', exact=True)).to_be_visible()
        assert await original_cost.evaluate('element => element.isConnected')
        retry = await hold(lambda: panel.get_by_role('button', name='Retry cost history', exact=True).click())
        assert await original_burn.evaluate('element => element.isConnected')
        await complete(retry)
        await expect(cost).to_have_attribute('data-window-start', str(latest-10800000))
        await expect(panel.get_by_role('button', name='Retry cost history', exact=True)).to_have_count(0)

        # Incompatible scopes must never display the preceding scope's values.
        for action, expected in [
            (lambda: panel.get_by_role('button', name='Filter costs for Opus 5.5', exact=True).click(), '$2.00'),
            (lambda: panel.get_by_role('combobox', name='Cost time resolution', exact=True).select_option('hour'), '$2.00'),
            (lambda: panel.get_by_role('combobox', name='Group costs by', exact=True).select_option('model-reasoning'), '$4.00'),
            (lambda: page.get_by_role('combobox', name='Main session').select_option('phone-other'), '$9.00'),
        ]:
            gate = await hold(action)
            await expect(cost).to_have_count(0)
            await expect(burn).to_have_count(0)
            await expect(value).to_have_count(0)
            await complete(gate)
            await expect(value).to_have_text(expected)
        # The same query still refreshes in place on the existing five-second loop.
        current = await cost.element_handle()
        refresh = await hold(lambda: page.clock.fast_forward(5000))
        assert refresh['query']['sessionId'] == ['phone-other']
        assert await current.evaluate('element => element.isConnected')
        await complete(refresh)
        await expect(value).to_have_text('$9.00')
        assert await current.evaluate('element => element.isConnected')

    finally:
        for gate in gates:
            gate['release'].set()


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
            for check in [tree_hierarchy, agent_navigation, portrait_controls, header_contrast, graph_panels, tree_keyboard, activity_reading, same_session_live, cold_session_history, live_during_history_fetch, delayed_replay_cannot_regress_state, failed_history_can_retry, reconnect_refreshes_selected_history, reset_same_session_keeps_live_updates, new_stream_live_during_reconnect, context_bars_fit_portrait, reported_usage_costs, agent_status_filters, cost_history_graph, cost_history_retry, cost_burn_breakdown, cost_burn_trends, cost_readable_layout, agent_model_settings, cost_model_analytics, cost_cache_reuse, cost_cache_write_unknown, cost_time_views, cost_phone_gestures, cost_history_pending_queries]:
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
                    if os.environ.get('PHONE_CHECK_TRACEBACK'):
                        import traceback
                        traceback.print_exc()
                        print('Touch diagnostic:',await page.evaluate('''({events:window.__chartPointers?.slice(-20),scale:visualViewport.scale,scroll:document.querySelector('[aria-label="Session API costs"]')?.scrollTop})'''))
                    failures.append(f"{width}/{check.__name__}")
                    print("FAIL", width, check.__name__, str(error).split("Call log:")[0].strip(), flush=True)
                finally:
                    await context.close()
        await browser.close()
    if failures:
        raise SystemExit(f"{len(failures)} browser checks failed: {', '.join(failures)}")


if __name__ == '__main__':
    asyncio.run(main())
