"""Branchline fork: verify per-agent cost navigation against a built UI, using local fixtures."""
import asyncio
from datetime import datetime, timezone
import json
import os
import sys
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright, expect

SID = 'agent-cost-session'
NOW = 1792818000000
HOUR = 3600000
ZERO = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
TOKENS = dict(inputTokens=200, outputTokens=400, cacheReadTokens=600, cacheWriteTokens=800, cacheWrite1hTokens=200, reasoningTokens=100)


def group(agent_id, name, cost, parts, **extra):
    return dict(id=json.dumps(['agent', agent_id], separators=(',', ':')), agentId=agent_id, agentName=name,
                records=2, tokens=TOKENS, totalTokens=2000, costUSD=cost, knownCostUSD=cost,
                breakdownUSD=dict(ZERO, **parts), averageCostUSDPerMinute=cost / 120, **extra)


class Fixture:
    def __init__(self):
        self.requests = []
        self.gate = asyncio.Event()
        self.gate.set()
        self.groups = [group('main', 'Main session', 10, dict(input=2, output=4, cacheRead=1, cacheWrite=3)),
                       group('child-a', 'Reviewer', 10, dict(input=1.5, output=2.5, cacheRead=1.5, cacheWrite=4.5)),
                       group('child-b', 'Reviewer', 5, dict(input=1, output=1, cacheRead=1, cacheWrite=2)),
                       group('codex', 'Codex reviewer', 1, dict(input=.5, output=.4, cacheRead=.1), cacheWritesUnknown=True)]
        self.groups += [group(f'worker-{i}', 'Worker ' + str(i) + ' with a long descriptive task name', 0, {}) for i in range(12)]

    async def history(self, route):
        q = parse_qs(urlparse(route.request.url).query)
        self.requests.append(q)
        selected = q.get('group', [None])[0]
        if selected:
            await self.gate.wait()
        agents = q.get('groupBy') == ['agent']
        chosen = next((g for g in self.groups if g['id'] == selected), None) if agents else None
        total = chosen['knownCostUSD'] if chosen else 26
        parts = chosen['breakdownUSD'] if chosen else dict(input=5, output=7.9, cacheRead=3.6, cacheWrite=9.5, unattributed=0)
        start = int(q.get('start', [NOW - 2 * HOUR])[0])
        end = int(q.get('end', [NOW])[0])
        rates = [dict(timestamp=t, costUSDPerMinute=total / 120, breakdownUSDPerMinute={k: v / 120 for k, v in parts.items()}) for t in range(start, end, HOUR)]
        history = dict(points=[dict(timestamp=start + 1, costUSD=total / 2, breakdownUSD={k: v / 2 for k, v in parts.items()}),
                               dict(timestamp=end - 1, costUSD=total, breakdownUSD=parts)],
                       totalCostUSD=total, untimedCostUSD=0, unpricedResponses=0, group=selected, groupBy='agent' if agents else 'model',
                       groups=self.groups if agents else [], resolution=q.get('resolution', ['auto'])[0],
                       window=dict(start=start, end=end, startCostUSD=0, startBreakdownUSD=ZERO), bounds=dict(start=NOW - 10 * 24 * HOUR, end=NOW),
                       burnRate=dict(bucketMs=HOUR, endTimestamp=end, points=rates))
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId=SID, history=history)))

    async def install(self, page):
        await page.clock.install(time=datetime.fromtimestamp(NOW / 1000, timezone.utc))
        session = dict(id=SID, label='Subagent cost test', status='active', runtime='claude', provider='anthropic', startTime=NOW - HOUR, lastActivityTime=NOW)
        events = [dict(type='agent_spawn', payload=dict(name='orchestrator', isMain=True, runtime='claude'), time=0, sessionId=SID, eventId=1, streamId=SID)]
        stream = ''.join('data: ' + json.dumps(packet) + '\n\n' for packet in [dict(type='session-list', sessions=[session]), dict(type='agent-event-batch', events=events)])
        await page.route('**/events*', lambda r: r.fulfill(status=200, content_type='text/event-stream', body=stream))
        await page.route('**/session-events?*', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId=SID, throughEventId=1, events=events))))
        await page.route('**/session-cost-history?*', self.history)


async def check(page, origin, width):
    fixture = Fixture()
    await fixture.install(page)
    await page.goto(origin, wait_until='domcontentloaded')
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs', exact=True)
    await panel.get_by_role('tab', name='Spend', exact=True).click()
    await expect(panel.get_by_label('Chart headline', exact=True)).to_have_text('$26.00')
    agents = panel.get_by_role('button', name='Costs by agent', exact=True)
    await expect(agents).to_be_visible(timeout=2000)
    await agents.click()
    listing = panel.get_by_role('region', name='Costs by agent', exact=True)
    row = listing.locator('[data-agent-cost="child-a"]')
    await expect(row.locator('summary')).to_contain_text('child-a')
    await row.locator('summary').click()
    for label, amount in [('Input', '$1.50'), ('Output', '$2.50'), ('Cache read', '$1.50'), ('Cache write', '$4.50')]:
        await expect(row.get_by_label(label + ' cost', exact=True)).to_have_text(amount)
    assert await listing.locator('[data-agent-cost]').count() == 10
    await listing.get_by_role('button', name='Show more agent costs', exact=True).click()
    assert await listing.locator('[data-agent-cost]').count() == 16
    await listing.get_by_role('searchbox', name='Search agent costs', exact=True).fill('worker 11')
    await expect(listing.locator('[data-agent-cost]')).to_have_count(1)
    await listing.get_by_role('searchbox', name='Search agent costs', exact=True).fill('')
    if not await row.evaluate('e => e.open'):
        await row.locator('summary').click()
    print('PASS', width, 'per-agent dollars, pagination and search', flush=True)
    fixture.gate.clear()
    await row.get_by_role('button', name='View charts for Reviewer · child-a', exact=True).click()
    await expect(panel.get_by_label('Chart headline', exact=True)).to_have_text('—')
    fixture.gate.set()
    await expect(panel.get_by_label('Chart headline', exact=True)).to_have_text('$10.00')
    assert fixture.requests[-1].get('group') == ['["agent","child-a"]']
    await panel.get_by_role('tab', name='Burn', exact=True).click()
    await expect(panel.get_by_role('img', name='API dollar burn rate', exact=True)).to_be_visible()
    await panel.get_by_role('tab', name='Compare', exact=True).click()
    await expect(panel.get_by_role('img', name='Daily burn rate comparison', exact=True)).to_be_visible()
    assert any(q.get('fixedWindow') == ['true'] and q.get('groupBy') == ['agent'] and q.get('group') == ['["agent","child-a"]'] for q in fixture.requests)
    print('PASS', width, 'agent-scoped spend, burn and daily comparisons; no stale totals', flush=True)
    await panel.get_by_role('tab', name='Spend', exact=True).click()
    await panel.get_by_role('button', name='Show costs for all agents', exact=True).click()
    await expect(panel.get_by_label('Chart headline', exact=True)).to_have_text('$26.00')
    await agents.click()
    codex = listing.locator('[data-agent-cost="codex"]')
    await codex.locator('summary').click()
    await expect(codex.get_by_label('Cache write cost', exact=True)).to_have_text('Unknown')
    await codex.get_by_role('button', name='View charts for Codex reviewer', exact=True).click()
    await expect(panel.get_by_label('Chart headline', exact=True)).to_have_text('$1.00')
    await expect(panel.get_by_role('region', name='Cache write data unavailable', exact=True)).to_be_visible()
    await panel.get_by_role('tab', name='Compare', exact=True).click()
    await panel.get_by_role('combobox', name='Burn rate source', exact=True).select_option('cacheWrite')
    await expect(panel.get_by_text('Cache-write burn is unknown for these Codex logs. A missing write count cannot be compared as zero spending.', exact=True)).to_be_visible()
    assert await panel.evaluate('e => e.scrollWidth <= e.clientWidth + 1')
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    print('PASS', width, 'all-agents reset, unknown cache writes and portrait width', flush=True)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE'])
        for width in [390, 1280]:
            context = await browser.new_context(viewport=dict(width=width, height=844), is_mobile=width < 640, has_touch=width < 640)
            page = await context.new_page()
            await check(page, sys.argv[1], width)
            await context.close()
        await browser.close()


asyncio.run(main())
