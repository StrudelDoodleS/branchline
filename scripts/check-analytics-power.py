# Branchline fork modifications; see FORK.md.
"""Check analytics work against a built UI.

uvx --from playwright python scripts/check-analytics-power.py URL [check,...]
The visibility double dispatches the real event; no OS minimize is required.
"""
import asyncio
from datetime import datetime, timezone
import json
import os
import sys
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

SID = 'analytics-power'
NOW = 1792679400000  # 2026-10-22 14:30 UTC; avoid a minute rollover during a five-second poll.
HOUR = 3600000
ZERO = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
VISIBILITY = """window.__analyticsHidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__analyticsHidden });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__analyticsHidden ? 'hidden' : 'visible' });
window.__setAnalyticsHidden = hidden => { window.__analyticsHidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
window.__costSeriesMaps = 0;
const arrayMap = Array.prototype.map;
Array.prototype.map = function (...args) {
  if (this.length && this[0] && typeof this[0] === 'object' && 'timestamp' in this[0] && 'costUSD' in this[0]) window.__costSeriesMaps++;
  return arrayMap.apply(this, args);
};
window.__spendDates = new Set(); window.__spendDateFormats = 0;
const localeDate = Date.prototype.toLocaleDateString;
Date.prototype.toLocaleDateString = function (...args) {
  if (window.__spendDates.has(+this)) window.__spendDateFormats++;
  return localeDate.apply(this, args);
};"""


def overview(indexing=False):
    tokens = dict(inputTokens=100, outputTokens=100, cacheReadTokens=0, cacheWriteTokens=0, cacheWrite1hTokens=0, reasoningTokens=0)
    session = dict(id='saved-analytics', label='Saved analytics', runtime='claude', provider='anthropic', historical=True,
                   project='battery', status='completed', startTime=NOW-86400000, lastActivityTime=NOW-60000)
    parts = dict(ZERO, input=100)
    return dict(status=dict(state='indexing' if indexing else 'ready', processed=0 if indexing else 1, total=1, indexed=0 if indexing else 1, updatedAt=NOW),
                window=dict(start=None, end=NOW), totals=dict(knownCostUSD=0 if indexing else 100, unpricedResponses=0, untimedResponses=0, untimedKnownCostUSD=0, records=1, breakdownUSD=parts, tokens=tokens),
                days=[dict(day='2026-10-22', knownCostUSD=100, unpricedResponses=0, records=1, breakdownUSD=parts)],
                providers=[dict(provider='anthropic', sessions=1, knownCostUSD=100, unpricedResponses=0, records=1)], models=[],
                sessions=[dict(session=session, indexed=not indexing, knownCostUSD=100, unpricedResponses=0, records=1, agentCount=1)])


class Fixture:
    def __init__(self):
        self.history_requests = []
        self.overview_requests = []
        self.indexing = False
        self.unpriced = False

    async def history(self, route):
        q = parse_qs(urlparse(route.request.url).query)
        self.history_requests.append(q)
        start, end = (int(q['start'][0]), int(q['end'][0])) if q.get('fixedWindow') == ['true'] else (NOW-3*86400000, NOW)
        points = [dict(timestamp=start, costUSD=1, breakdownUSD=dict(ZERO, input=1)), dict(timestamp=end, costUSD=2, breakdownUSD=dict(ZERO, input=2))]
        rates = [dict(timestamp=t, costUSDPerMinute=.1, breakdownUSDPerMinute=dict(ZERO, input=.1)) for t in range(start, end, HOUR)]
        history = dict(points=points, totalCostUSD=2, untimedCostUSD=0, unpricedResponses=int(self.unpriced), groups=[],
                       window=dict(start=start, end=end, startCostUSD=0, startBreakdownUSD=ZERO),
                       bounds=dict(start=NOW-10*86400000, end=NOW), burnRate=dict(bucketMs=HOUR, endTimestamp=end, points=rates))
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId=SID, history=history)))

    async def spend(self, route):
        q = parse_qs(urlparse(route.request.url).query)
        self.overview_requests.append(q)
        data = overview(self.indexing)
        if q.get('status') == ['1']:
            data = dict(status=data['status'])
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(data))

    async def install(self, page):
        await page.add_init_script(VISIBILITY)
        await page.clock.install(time=datetime.fromtimestamp(NOW / 1000, timezone.utc))
        sessions = [dict(id=SID, label='Analytics power', status='active', startTime=NOW, lastActivityTime=NOW)]
        events = [dict(type='agent_spawn', payload=dict(name='Orchestrator', isMain=True, runtime='claude'), time=0, sessionId=SID, eventId=1, streamId=SID)]
        stream = ''.join('data: '+json.dumps(packet)+'\n\n' for packet in [dict(type='session-list', sessions=sessions), dict(type='agent-event-batch', events=events)])
        await page.route('**/events*', lambda r: r.fulfill(status=200, content_type='text/event-stream', body=stream))
        await page.route('**/session-events?*', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId=SID, throughEventId=1, events=events))))
        await page.route('**/session-cost-history?*', self.history)
        await page.route('**/spend-overview*', self.spend)


async def flush(page):
    # Let fetch handlers and React effects run after advancing the browser clock.
    await page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => resolve()))')


async def visibility(page, hidden):
    await page.evaluate('hidden => window.__setAnalyticsHidden(hidden)', hidden)
    await flush(page)


async def parent_update(page):
    usage = dict(inputTokens=100, outputTokens=100, cacheReadTokens=0, cacheWriteTokens=0, cacheWrite1hTokens=0, reasoningTokens=0, totalTokens=200, costUSD=2)
    event = dict(type='context_update', payload=dict(agent='Orchestrator', tokens=12345, usage=usage), time=2, sessionId=SID, eventId=100, streamId=SID)
    await page.evaluate("event => window.postMessage({type:'agent-event-batch', events:[event]}, '*')", event)
    await page.clock.fast_forward(300)
    await flush(page)
    await expect(page.locator('[aria-label="Agent controls"]')).to_contain_text('~$2.00 API')


async def open_costs(page):
    await page.get_by_role('button', name='$Cost', exact=True).click()
    panel = page.get_by_role('region', name='Session API costs', exact=True)
    await expect(panel).to_be_visible()
    await expect(panel.get_by_role('region', name='Cost history', exact=True)).to_have_attribute('aria-busy', 'false')
    await expect(panel.get_by_role('img', name='Daily burn rate comparison', exact=True)).to_be_visible()
    return panel


async def history_visibility(page, fixture):
    panel = await open_costs(page)
    chart = panel.get_by_role('img', name='Daily burn rate comparison', exact=True)
    await expect(chart.locator('path[data-day]')).to_have_count(3)
    completed = [q for q in fixture.history_requests if q.get('fixedWindow') == ['true'] and int(q['end'][0]) < NOW]
    await visibility(page, True)
    before = len(fixture.history_requests)
    await page.clock.fast_forward(65000)
    await flush(page)
    assert len(fixture.history_requests) == before, 'Hidden cost analytics keep fetching history'
    await visibility(page, False)
    await expect(panel.get_by_role('region', name='Cost history', exact=True)).to_have_attribute('aria-busy', 'false')
    await expect(chart.locator('path[data-day][data-baseline="true"]')).to_have_attribute('data-window-end', str(NOW+60000))
    assert len(fixture.history_requests) > before, 'Resuming cost analytics did not fetch current history'
    after = [q for q in fixture.history_requests if q.get('fixedWindow') == ['true'] and int(q['end'][0]) < NOW]
    assert after == completed, 'Completed comparison days were refetched on resume'


async def overview_visibility(page, fixture):
    fixture.indexing = True
    await page.get_by_role('button', name='All session costs', exact=True).click()
    panel = page.get_by_role('dialog', name='All session costs', exact=True)
    await expect(panel).to_contain_text('Indexing')
    await page.evaluate('value => { window.__spendDates.add(value); window.__spendDateFormats = 0 }', NOW-60000)
    await page.clock.fast_forward(1600)
    await flush(page)
    assert any(q.get('status') == ['1'] for q in fixture.overview_requests), 'Index progress never used the status endpoint'
    assert await page.evaluate('window.__spendDateFormats') == 0, 'Indexing progress rebuilds unchanged session cost rows'
    await visibility(page, True)
    before = len(fixture.overview_requests)
    await page.clock.fast_forward(5000)
    await flush(page)
    assert len(fixture.overview_requests) == before, 'Hidden spend indexing keeps polling'
    fixture.indexing = False
    await visibility(page, False)
    await expect(panel.get_by_label('Global spend', exact=True)).to_have_text('$100.00')
    assert fixture.overview_requests[-1].get('status') != ['1'], 'Resume must load fresh figures rather than only progress'


async def unchanged_history(page, fixture):
    panel = await open_costs(page)
    await panel.get_by_role('tab', name='Spend', exact=True).click()
    chart = panel.get_by_role('img', name='API cost over time', exact=True)
    await expect(chart).to_be_visible()
    before_paths = await chart.locator('path').evaluate_all('paths => paths.map(path => path.getAttribute("d"))')
    await flush(page)
    await page.evaluate('window.__costSeriesMaps = 0')
    await parent_update(page)
    await page.clock.fast_forward(1200)
    await flush(page)
    assert await page.evaluate('window.__costSeriesMaps') == 0, 'Unchanged parent clocks rebuild cost plot series'
    before_requests = len(fixture.history_requests)
    await page.clock.fast_forward(5000)
    await flush(page)
    assert len(fixture.history_requests) > before_requests, 'Visible history no longer refreshes every five seconds'
    assert await page.evaluate('window.__costSeriesMaps') == 0, 'Identical history responses rebuild cost plot series'
    assert await chart.locator('path').evaluate_all('paths => paths.map(path => path.getAttribute("d"))') == before_paths
    fixture.unpriced = True
    await page.clock.fast_forward(5000)
    await expect(panel.get_by_text('Pricing is unavailable for part of this session.', exact=True)).to_be_visible()


async def overview_row_reuse(page, fixture):
    await page.get_by_role('button', name='All session costs', exact=True).click()
    panel = page.get_by_role('dialog', name='All session costs', exact=True)
    await expect(panel.get_by_label('Global spend', exact=True)).to_have_text('$100.00')
    await page.evaluate('value => { window.__spendDates.add(value); window.__spendDateFormats = 0 }', NOW-60000)
    await parent_update(page)
    await page.clock.fast_forward(1200)
    await flush(page)
    assert await page.evaluate('window.__spendDateFormats') == 0, 'Unchanged parent clocks rebuild session cost rows'
    await panel.get_by_role('searchbox', name='Search session costs', exact=True).fill('absent')
    await expect(panel.get_by_role('button', name='Open costs for Saved analytics', exact=True)).to_have_count(0)
    await panel.get_by_role('searchbox', name='Search session costs', exact=True).fill('battery')
    await expect(panel.get_by_role('button', name='Open costs for Saved analytics', exact=True)).to_be_visible()


async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3001'
    selected = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else None
    failures = []
    async with async_playwright() as p:
        launch = dict(headless=True, args=['--no-sandbox'])
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
            launch['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        browser = await p.chromium.launch(**launch)
        for check in [history_visibility, overview_visibility, unchanged_history, overview_row_reuse]:
            if selected and check.__name__ not in selected:
                continue
            context = await browser.new_context(viewport=dict(width=390, height=844), is_mobile=True, has_touch=True, timezone_id='UTC')
            page = await context.new_page()
            page.set_default_timeout(4000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            fixture = Fixture()
            await fixture.install(page)
            try:
                await page.goto(url, wait_until='domcontentloaded')
                await expect(page.get_by_role('button', name='Browse sessions', exact=True)).to_have_attribute('data-session-id', SID)
                await check(page, fixture)
                assert not errors, errors
                print('PASS', check.__name__, flush=True)
            except Exception as error:
                failures.append(check.__name__)
                print('FAIL', check.__name__, str(error).split('Call log:')[0], flush=True)
                if errors:
                    print('Browser errors:', errors, flush=True)
            finally:
                await context.close()
        await browser.close()
    if failures:
        raise SystemExit(f'{len(failures)} analytics checks failed: {failures}')


if __name__ == '__main__':
    asyncio.run(main())
