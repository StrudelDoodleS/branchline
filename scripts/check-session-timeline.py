# Branchline fork modifications; see FORK.md.
"""Fixture-only timeline regression: uvx --from playwright python scripts/check-session-timeline.py URL [check,...].

Removing selection identity checks, paging resets, or the visibility lifecycle must
fail these checks. Every data endpoint is intercepted; no private history is read.
"""
import asyncio
from datetime import date, datetime, timedelta, timezone
import json
import os
import sys
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect

SID = 'timeline-fixture'
NOW = 1792931400000
ZERO = dict(input=0, output=0, cacheRead=0, cacheWrite=0, unattributed=0)
VISIBILITY = """window.__timelineHidden = false;
Object.defineProperty(document, 'hidden', {configurable:true,get:()=>window.__timelineHidden});
Object.defineProperty(document, 'visibilityState', {configurable:true,get:()=>window.__timelineHidden?'hidden':'visible'});
window.__setTimelineHidden = hidden => {window.__timelineHidden=hidden;document.dispatchEvent(new Event('visibilitychange'))};
window.__timelineDraws=0;const originalClear=CanvasRenderingContext2D.prototype.clearRect;
CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.isConnected)window.__timelineDraws++;return originalClear.apply(this,args)};
window.__timelineDates=0;const originalDate=Date.prototype.toLocaleDateString;
Date.prototype.toLocaleDateString=function(...args){window.__timelineDates++;return originalDate.apply(this,args)};"""


def totals(records=1100, cost=42.125, agents=1100, unpriced=1):
    return dict(records=records, agentCount=agents, knownCostUSD=cost, costUSD=None if unpriced else cost,
                unpricedResponses=unpriced, cacheWritesUnknown=bool(unpriced),
                breakdownUSD=dict(input=20, output=20, cacheRead=2, cacheWrite=.125, unattributed=0) if cost else ZERO)


class Fixture:
    def __init__(self):
        self.requests = []
        self.delay = None
        self.gate = asyncio.Event()
        self.fail = False
        self.empty = False
        self.all_unpriced = False
        self.price = None
        self.hold_all = False

    async def history(self, route):
        q = parse_qs(urlparse(route.request.url).query)
        self.requests.append(q)
        if self.hold_all:
            await self.gate.wait()
        if self.delay and q.get('timelineDay') == [self.delay[0]] and q.get('timelineSlot') == [str(self.delay[1])]:
            await self.gate.wait()
        if self.fail:
            await route.fulfill(status=503, body='fixture unavailable')
            return
        older = bool(q.get('timelineBefore'))
        end = date(2026, 10, 11 if older else 25)
        days = []
        for i in range(14):
            day = (end - timedelta(days=13-i)).isoformat()
            cells = [dict(totals(0, 0, 0, 0), day=day, slot=slot) for slot in range(4)]
            days.append(dict(day=day, cells=cells))
        if not self.empty:
            days[-1]['cells'][2].update(totals(1100, 0 if self.all_unpriced else self.price if self.price is not None else 42.125, 1100, 1100 if self.all_unpriced else 1))
            days[-2]['cells'][1].update(totals(2, 7, 2, 0))
        day = q.get('timelineDay', [end.isoformat()])[0]
        slot = int(q.get('timelineSlot', ['2'])[0])
        offset = int(q.get('timelineOffset', ['0'])[0])
        cell = next((c for d in days for c in d['cells'] if c['day'] == day and c['slot'] == slot), None)
        agents = [] if cell is None else [dict(totals(1, 0 if self.all_unpriced else .125, 1, 1 if self.all_unpriced else 0), agentId=f'native-{i:04}', agentName='Repeated worker')
                                         for i in range(offset, min(offset+20, cell['agentCount']))]
        timeline = dict(timezone='Europe/Berlin', metric=q.get('timelineMetric', ['cost'])[0], firstDay=None if self.empty else '2026-10-01',
                        lastDay=None if self.empty else '2026-10-25', window=dict(firstDay=days[0]['day'], lastDay=end.isoformat(),
                        olderBefore=None if older else days[0]['day'], newerBefore='2026-10-26' if older else None),
                        days=[] if self.empty else days, totals=totals(1102, 49.125, 1100),
                        allTime=dict(totals(1105, 50.625, 1100), untimedResponses=3, untimedKnownCostUSD=1.5),
                        selected=None if self.empty or cell is None else dict(cell=cell, agents=agents, offset=offset, hasMore=offset+20<cell['agentCount']))
        history = dict(points=[], totalCostUSD=50.625, untimedCostUSD=1.5, unpricedResponses=1,
                       window=dict(start=NOW-86400000, end=NOW, startCostUSD=0, startBreakdownUSD=ZERO),
                       bounds=dict(start=NOW-86400000, end=NOW), burnRate=dict(bucketMs=3600000, endTimestamp=NOW, points=[]), timeline=timeline)
        await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(sessionId=q['sessionId'][0], history=history)))

    async def install(self, page):
        await page.add_init_script(VISIBILITY)
        await page.clock.install(time=datetime.fromtimestamp(NOW/1000, timezone.utc))
        sessions = [dict(id=sid, label=label, status='active', startTime=NOW, lastActivityTime=NOW)
                    for sid, label in [(SID, 'Thousand agent fixture'), ('other-timeline', 'Other timeline fixture')]]
        events = [dict(type='agent_spawn', payload=dict(name='Orchestrator', isMain=True, runtime='claude'), time=0,
                       sessionId=s['id'], streamId=SID, eventId=i+1) for i, s in enumerate(sessions)]
        stream = ''.join('data: '+json.dumps(p)+'\n\n' for p in [dict(type='session-list', sessions=sessions), dict(type='agent-event-batch', events=events)])
        await page.route('**/events*', lambda r: r.fulfill(status=200, content_type='text/event-stream', body=stream))
        await page.route('**/session-events?*', lambda r: r.fulfill(status=200, content_type='application/json', body=json.dumps(dict(streamId=SID, throughEventId=2, events=events))))
        await page.route('**/session-cost-history?*', self.history)
        await page.route('**/session-catalog*', lambda r: r.fulfill(status=200, content_type='application/json', body='{"sessions":[]}'))
        await page.route('**/spend-overview*', lambda r: r.fulfill(status=200, content_type='application/json', body='{}'))


async def opened(page):
    await page.get_by_role('button', name='Timeline', exact=True).click()
    panel = page.get_by_role('dialog', name='Time & cost', exact=True)
    await expect(panel).to_be_visible()
    return panel


async def bounded_portrait(page, fixture):
    panel = await opened(page)
    await expect(panel.locator('button[data-timeline-cell]')).to_have_count(56)
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(20)
    await expect(panel.locator('canvas')).to_have_count(0)
    await expect(panel).to_contain_text('1,100 agents')
    await expect(panel).to_contain_text('Europe/Berlin')
    await expect(panel).to_contain_text('3 responses without timestamps')
    await expect(panel).to_contain_text('1 response unpriced')
    await expect(panel).to_contain_text('Cache-write usage is unknown')
    await expect(panel.get_by_role('region',name='Selected period',exact=True).locator('dl > div').filter(has=page.locator('dt',has_text='Cache writes')).first).to_contain_text('unknown')
    await page.keyboard.press('Shift+Tab')
    await expect(panel.get_by_role('button', name='Next agents', exact=True)).to_be_focused()
    await page.keyboard.press('Tab')
    await expect(panel.get_by_role('button', name='Close timeline', exact=True)).to_be_focused()
    await panel.get_by_role('button', name='Next agents', exact=True).click()
    await expect(panel.locator('[data-timeline-agent]').first).to_contain_text('native-0020')
    await panel.locator('[data-timeline-agent]').first.locator('summary').click()
    await expect(panel.locator('[data-timeline-agent]').first).to_contain_text('$0.125000')
    await panel.get_by_role('button', name='Responses', exact=True).click()
    await expect(panel.locator('[data-timeline-agent]').first).to_contain_text('native-0000')
    assert fixture.requests[-1].get('timelineMetric') == ['responses']
    assert fixture.requests[-1].get('timelineOffset', ['0']) == ['0']
    overflow = await page.evaluate('document.documentElement.scrollWidth > innerWidth')
    assert not overflow, 'Timeline overflows the phone viewport'
    close = panel.get_by_role('button', name='Close timeline', exact=True)
    box = await close.bounding_box()
    assert box['width'] >= 44 and box['height'] >= 44, box
    await close.scroll_into_view_if_needed()
    assert await close.evaluate('(el)=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}'), 'Close is covered by app controls'
    await page.screenshot(path=f'/tmp/branchline-timeline-{page.viewport_size["width"]}.png')


async def navigation_and_stale_selection(page, fixture):
    panel = await opened(page)
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(20)
    fixture.delay = ('2026-10-24', 1)
    await panel.locator('button[data-timeline-cell="2026-10-24:1"]').click()
    await expect(panel.get_by_role('region', name='Selected period', exact=True)).to_contain_text('Loading period')
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(0)
    await expect(panel.locator('button[data-timeline-cell]')).to_have_count(56)
    await panel.locator('button[data-timeline-cell="2026-10-23:0"]').click()
    await expect(panel.get_by_role('region', name='Selected period', exact=True)).to_contain_text('No recorded responses')
    fixture.gate.set()
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(0)
    await panel.get_by_role('button', name='Older', exact=True).click()
    await expect(panel.locator('button[data-timeline-cell="2026-10-11:2"]')).to_have_count(1)
    assert 'timelineDay' not in fixture.requests[-1], 'Date navigation retained an out-of-page selection'
    await panel.get_by_role('button', name='Latest', exact=True).click()
    await expect(panel.locator('button[data-timeline-cell="2026-10-25:2"]')).to_have_count(1)
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(20)
    fixture.gate.clear()
    await panel.locator('button[data-timeline-cell="2026-10-24:1"]').click()
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(0)
    await page.keyboard.press('Escape')
    await expect(panel).to_have_count(0)
    await expect(page.get_by_role('button', name='Timeline', exact=True)).to_be_focused()
    await page.get_by_role('button', name='Browse sessions', exact=True).click()
    choice = page.locator('button[data-session-choice="other-timeline"]')
    group = choice.locator('xpath=ancestor::li[@data-session-group]')
    toggle = group.locator('button[data-session-group-toggle]')
    if await toggle.get_attribute('aria-expanded') == 'false':
        await toggle.click()
    await choice.click()
    panel = await opened(page)
    await expect(panel).to_contain_text('Other timeline fixture')
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(20)
    fixture.gate.set()
    assert fixture.requests[-1]['sessionId'] == ['other-timeline']
    assert 'timelineDay' not in fixture.requests[-1]


async def lifecycle_and_retry(page, fixture):
    panel = await opened(page)
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(20)
    assert fixture.requests[-1].get('timeline') == ['true']
    assert fixture.requests[-1].get('timezone') == ['Europe/Berlin']
    before = len(fixture.requests)
    async with page.expect_response('**/session-cost-history?*'):
        await page.clock.fast_forward(31000)
    assert len(fixture.requests) > before, 'Visible timeline does not refresh'
    await page.evaluate('window.__setTimelineHidden(true)')
    before = len(fixture.requests)
    await page.clock.fast_forward(65000)
    assert len(fixture.requests) == before, 'Hidden timeline keeps polling'
    fixture.fail = True
    await page.evaluate('window.__setTimelineHidden(false)')
    await expect(panel.get_by_role('button', name='Retry', exact=True)).to_be_visible()
    fixture.fail = False
    fixture.empty = True
    await panel.get_by_role('button', name='Retry', exact=True).click()
    await expect(panel).to_contain_text('No timestamped usage')
    await panel.get_by_role('button', name='Close timeline', exact=True).click()
    before = len(fixture.requests)
    await page.clock.fast_forward(65000)
    assert len(fixture.requests) == before, 'Closed timeline keeps polling'


async def absent_prices(page, fixture):
    fixture.all_unpriced = True
    panel = await opened(page)
    selected = panel.get_by_role('region', name='Selected period', exact=True)
    await expect(selected).to_contain_text('Price unavailable')
    await expect(selected).to_contain_text('1,100 responses unpriced')
    await expect(selected.locator('dl > div').filter(has=page.locator('dt',has_text='Cache writes')).first).to_contain_text('Unknown')
    for source in ['Input','Output','Cache reads','Unattributed']:
        await expect(selected.locator('dl > div').filter(has=page.locator('dt',has_text=source)).first.locator('dd')).to_have_text('Unknown')
    await expect(panel.locator('button[data-timeline-cell="2026-10-25:2"]')).to_contain_text('?')


async def covered_graph(page, fixture):
    await page.get_by_role('button', name='Graph', exact=True).click()
    panel = await opened(page)
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(20)
    # Flush the cover transition, then inspect work across simulated live ticks.
    await page.clock.fast_forward(300)
    await page.evaluate('window.__timelineDraws=0;window.__timelineDates=0')
    await page.clock.fast_forward(3000)
    assert await page.evaluate('window.__timelineDraws') == 0, 'Covered graph keeps drawing beneath timeline'
    assert await page.evaluate('window.__timelineDates') == 0, 'Parent clock ticks rebuild the unchanged calendar'


async def currency_cells_fit(page, fixture):
    fixture.price = 1234567.89
    panel = await opened(page)
    cell=panel.locator('button[data-timeline-cell="2026-10-25:2"]')
    await expect(cell).to_be_visible()
    assert await cell.evaluate('el=>el.scrollWidth<=el.clientWidth+1'), 'Large prices overflow calendar cells'
    assert not await page.evaluate('document.documentElement.scrollWidth>innerWidth'), 'Large prices overflow portrait page'


async def cold_history_deadline(page, fixture):
    fixture.hold_all = True
    panel = await opened(page)
    await expect(panel.get_by_role('status')).to_contain_text('Loading timeline')
    await page.clock.fast_forward(15000)
    await expect(panel.get_by_role('button',name='Retry',exact=True)).to_have_count(0)
    fixture.gate.set()
    await expect(panel.locator('[data-timeline-agent]')).to_have_count(20)


async def main():
    url = sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:3001'
    selected = set(sys.argv[2].split(',')) if len(sys.argv)>2 else None
    failures = []
    async with async_playwright() as p:
        launch = dict(headless=True, args=['--no-sandbox'])
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
            launch['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        browser = await p.chromium.launch(**launch)
        for width in [320, 390, 1280]:
            for check in [bounded_portrait, navigation_and_stale_selection, lifecycle_and_retry, absent_prices, covered_graph, currency_cells_fit, cold_history_deadline]:
                if selected and check.__name__ not in selected:
                    continue
                context = await browser.new_context(viewport=dict(width=width, height=844), is_mobile=width<640, has_touch=width<640, timezone_id='Europe/Berlin')
                page = await context.new_page()
                page.set_default_timeout(2500)
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                fixture = Fixture()
                await fixture.install(page)
                try:
                    await page.goto(url, wait_until='domcontentloaded')
                    await expect(page.get_by_role('button', name='Browse sessions', exact=True)).to_have_attribute('data-session-id', SID)
                    await check(page, fixture)
                    assert not errors, errors
                    print('PASS', width, check.__name__, flush=True)
                except Exception as error:
                    fixture.gate.set()
                    failures.append(f'{width}/{check.__name__}')
                    print('FAIL', width, check.__name__, str(error).split('Call log:')[0], flush=True)
                    if os.environ.get('TIMELINE_CHECK_TRACEBACK'):
                        import traceback
                        traceback.print_exc()
                finally:
                    await context.close()
        await browser.close()
    if failures:
        raise SystemExit(f'{len(failures)} timeline checks failed: {failures}')


if __name__ == '__main__':
    asyncio.run(main())
