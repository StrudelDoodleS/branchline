# Branchline fork modifications; see FORK.md.
"""Exercise graph layout and real touch input against a built UI.

uvx --from playwright python scripts/check-phone-graph.py URL [check,...]
"""

import asyncio
import json
import os
import sys
import time
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright, expect


NAMES = ['Root', 'Z', 'Y', 'X']
CAPTURE = """window.__graphLabels = new Map();
window.__canvasResizes = 0;
for (const key of ['width','height']) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
  Object.defineProperty(HTMLCanvasElement.prototype,key, {...descriptor, set(value) {
    if (this.isConnected) window.__canvasResizes++;
    descriptor.set.call(this,value);
  }});
}
const fillText = CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText = function(text, x, y, ...args) {
  if (this.canvas.isConnected && ['Root','Z','Y','X'].includes(text)) {
    const t = this.getTransform(), p = t.transformPoint(new DOMPoint(x,y));
    const box = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio;
    window.__graphLabels.set(text, {x:box.left+p.x/dpr,y:box.top+p.y/dpr,
      scale:t.a/dpr,worldX:x,worldY:y,time:performance.now()});
  }
  return fillText.call(this,text,x,y,...args);
};"""


def fixture():
    now = int(time.time() * 1000)
    sessions = [dict(id='graph-fixture', label='Graph touch regression', status='active', startTime=now, lastActivityTime=now)]
    events = []
    for index, name in enumerate(NAMES):
        payload = dict(name=name, runtime='claude', isMain=index == 0)
        if index:
            payload['parent'] = NAMES[index - 1]
        events.append(dict(type='agent_spawn', payload=payload, time=index / 10,
                           sessionId='graph-fixture', eventId=index + 1, streamId='graph-fixture'))
    return sessions, events


async def frames(page, count=2):
    await page.evaluate('''count => new Promise(resolve => {
      const tick = () => --count <= 0 ? resolve() : requestAnimationFrame(tick);
      requestAnimationFrame(tick);
    })''', count)


async def labels(page):
    return await page.evaluate('Object.fromEntries(window.__graphLabels)')


async def settled(page):
    # Camera easing and the force layout must have settled before measuring input.
    previous = await labels(page)
    for _ in range(100):
        await frames(page, 6)
        current = await labels(page)
        if len(current) == len(NAMES) and len(previous) == len(NAMES):
            if all(abs(current[name]['x'] - previous[name]['x']) < .2 and
                   abs(current[name]['y'] - previous[name]['y']) < .2 for name in NAMES):
                return current
        previous = current
    raise AssertionError('Graph camera never settled')


async def touch(cdp, kind, points):
    await cdp.send('Input.dispatchTouchEvent', dict(type=kind, touchPoints=[
        dict(id=index + 1, x=x, y=y) for index, (x, y) in enumerate(points)
    ]))


async def graph_fits_controls(page, cdp):
    points = await settled(page)
    controls = await page.get_by_role('region', name='Agent controls').bounding_box()
    header_bottom = controls['y'] + controls['height']
    for name, point in points.items():
        radius = 28 if name == 'Root' else 20
        top = point['y'] - (radius * 2 + 8) * point['scale']
        assert top >= header_bottom, f'{name} is hidden behind the header: top={top:.1f}, header={header_bottom:.1f}'
        left, right = point['x'] - radius * point['scale'], point['x'] + radius * point['scale']
        assert 0 <= left <= right <= page.viewport_size['width'], f'{name} lies outside the viewport: {point}'
        assert point['y'] + 12 * point['scale'] <= page.viewport_size['height'] - 88, f'{name} is clipped beneath the graph'
    assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')


async def fractional_dpr_keeps_canvas_stable(page, cdp):
    await settled(page)
    await page.evaluate('window.__canvasResizes = 0')
    await frames(page, 12)
    writes = await page.evaluate('window.__canvasResizes')
    assert writes == 0, f'Static graph reallocates its canvas every frame at fractional pixel density: {writes} resizes'
    await page.screenshot(path=f'/tmp/branchline-graph-fitted-{page.viewport_size["width"]}.png')


async def touch_pan(page, cdp):
    before = await settled(page)
    # This starts in empty canvas, away from the nodes and floating panels.
    await touch(cdp, 'touchStart', [(20, 660)])
    for step in range(1, 6):
        await touch(cdp, 'touchMove', [(20 + step * 12, 660 + step * 6)])
    await frames(page)
    after = await labels(page)
    for name in NAMES:
        dx, dy = after[name]['x'] - before[name]['x'], after[name]['y'] - before[name]['y']
        assert 50 < dx < 70 and 20 < dy < 40, f'Touch drag did not pan {name}: dx={dx:.1f}, dy={dy:.1f}'
    await touch(cdp, 'touchEnd', [])
    await expect(page.locator('.agent-detail-card')).to_have_count(0)
    assert await page.evaluate('visualViewport.scale') == 1, 'Graph gesture zoomed the whole page'


async def touch_pinch(page, cdp):
    before = await settled(page)
    width = page.viewport_size['width']
    center = width / 2
    await touch(cdp, 'touchStart', [(center - 30, 620), (center + 30, 620)])
    for step in range(1, 6):
        await touch(cdp, 'touchMove', [(center - 30 - step * 9, 620), (center + 30 + step * 9, 620)])
    await frames(page)
    after = await labels(page)
    ratio = after['Root']['scale'] / before['Root']['scale']
    assert 2.2 < ratio < 2.8, f'Touch pinch did not zoom the graph around the fingers: scale ratio={ratio:.2f}'
    assert await page.evaluate('visualViewport.scale') == 1, 'Graph pinch zoomed the whole page'
    await touch(cdp, 'touchEnd', [])
    await expect(page.locator('.agent-detail-card')).to_have_count(0)


async def fit_after_navigation(page, cdp):
    before = await settled(page)
    await page.locator('canvas').hover(position=dict(x=20, y=360))
    await page.mouse.wheel(60, 30)
    await frames(page)
    moved = await labels(page)
    assert abs(moved['Root']['x'] - before['Root']['x']) > 40, 'Wheel did not move the graph'
    await page.get_by_role('button', name='Fit graph', exact=True).click()
    after = await settled(page)
    assert abs(after['Root']['x'] - before['Root']['x']) < 2
    assert abs(after['Root']['y'] - before['Root']['y']) < 2


async def resize_paused_graph(page, cdp):
    await settled(page)
    await page.get_by_role('button', name='Review', exact=False).click()
    await page.set_viewport_size(dict(width=page.viewport_size['width'], height=700))
    await settled(page)
    await graph_fits_controls(page, cdp)


async def hidden_history_keeps_graph_readable(page, cdp):
    before = await settled(page)
    events = []
    parent = 'X'
    usage = dict(inputTokens=1, outputTokens=0, cacheReadTokens=0, cacheWriteTokens=0,
                 cacheWrite1hTokens=0, reasoningTokens=0, totalTokens=1, costUSD=.001)
    for index in range(30):
        name = f'History {index}'
        events.extend([dict(type='agent_spawn', payload=dict(name=name, parent=parent)),
                       dict(type='context_update', payload=dict(agent=name, tokens=1, usage=usage)),
                       dict(type='agent_complete', payload=dict(name=name))])
        parent = name
    for index, event in enumerate(events):
        event.update(time=2, eventId=100 + index, sessionId='graph-fixture', streamId='graph-fixture')
    await page.evaluate("events=>window.postMessage({type:'agent-event-batch',events},'*')", events)
    await expect(page.get_by_role('region', name='Agent controls')).to_contain_text('34 agents')
    after = await settled(page)
    assert after['Root']['scale'] >= before['Root']['scale'] * .9, 'Hidden billed agents shrank the active graph'
    await graph_fits_controls(page, cdp)


async def mouse_capture(page, cdp):
    before = await settled(page)
    box = await page.locator('canvas').bounding_box()
    x, y = box['x'] + 15, box['y'] + box['height'] - 30
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 70, y + 70, steps=5)
    await frames(page)
    after = await labels(page)
    assert 60 < after['Root']['x'] - before['Root']['x'] < 80, 'Mouse drag stopped at the canvas edge'
    assert 60 < after['Root']['y'] - before['Root']['y'] < 80, 'Mouse drag stopped at the canvas edge'
    await page.mouse.up()
    await expect(page.locator('.agent-detail-card')).to_have_count(0)


async def switching_sessions_resets_camera(page, cdp):
    await settled(page)
    await page.locator('canvas').hover(position=dict(x=20, y=360))
    await page.mouse.wheel(2000, 1000)
    await frames(page)
    moved = await labels(page)
    assert moved['Root']['x'] < 0, 'Fixture did not pan the old session offscreen'
    await page.get_by_role('button', name='Browse sessions', exact=True).click()
    panel = page.get_by_role('dialog', name='Sessions', exact=True)
    choice = panel.locator('button[data-session-choice="graph-second"]')
    group = choice.locator('xpath=ancestor::li[@data-session-group]')
    toggle = group.locator('button[data-session-group-toggle]')
    if await toggle.get_attribute('aria-expanded') == 'false':
        await toggle.click()
    await choice.click()
    await expect(page.get_by_role('button', name='Browse sessions', exact=True)).to_have_attribute('data-session-id', 'graph-second')
    await page.wait_for_function('''() => {
      const node = window.__graphLabels.get('Root');
      const controls = document.querySelector('[aria-label="Agent controls"]').getBoundingClientRect();
      return node && node.x > 0 && node.x < innerWidth && node.y > controls.bottom && node.y < innerHeight - 88;
    }''')


async def touch_select(page, cdp):
    points = await settled(page)
    point = points['Root']
    # Labels are drawn below the node; tap the centre of the main hexagon.
    await page.touchscreen.tap(point['x'], point['y'] - 36 * point['scale'])
    await expect(page.locator('.agent-detail-card')).to_be_visible()
    await expect(page.locator('.agent-detail-card')).to_contain_text('Root')


async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3001'
    requested = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else None
    failures = []
    async with async_playwright() as p:
        launch = dict(headless=True, args=['--no-sandbox'])
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
            launch['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        browser = await p.chromium.launch(**launch)
        for width in [360, 390, 1280]:
            for check in [graph_fits_controls, touch_pan, touch_pinch, touch_select, fit_after_navigation, resize_paused_graph, hidden_history_keeps_graph_readable, mouse_capture, switching_sessions_resets_camera, fractional_dpr_keeps_canvas_stable]:
                if check is fractional_dpr_keeps_canvas_stable and width != 390:
                    continue
                if width == 1280 and check in [touch_pan, touch_pinch, touch_select]:
                    continue
                if width != 1280 and check is mouse_capture:
                    continue
                if requested and check.__name__ not in requested:
                    continue
                context = await browser.new_context(viewport=dict(width=width, height=844), is_mobile=width < 640, has_touch=width < 640,
                                                    device_scale_factor=2.75 if check is fractional_dpr_keeps_canvas_stable else 1)
                page = await context.new_page()
                page.set_default_timeout(3000)
                await page.add_init_script(CAPTURE)
                sessions, events = fixture()
                if check is switching_sessions_resets_camera:
                    sessions.append(dict(sessions[0], id='graph-second', label='Another graph session'))
                    events.append(dict(type='agent_spawn', payload=dict(name='Root', runtime='claude', isMain=True),
                                       time=0, sessionId='graph-second', eventId=5, streamId='graph-fixture'))
                packets = [dict(type='session-list', sessions=sessions), dict(type='agent-event-batch', events=events)]
                stream = ''.join('data: ' + json.dumps(packet) + '\n\n' for packet in packets)
                await page.route('**/events*', lambda route: route.fulfill(status=200, content_type='text/event-stream', body=stream))
                async def replay(route):
                    session_id = parse_qs(urlparse(route.request.url).query)['sessionId'][0]
                    selected = [event for event in events if event['sessionId'] == session_id]
                    await route.fulfill(status=200, content_type='application/json', body=json.dumps(dict(
                        streamId='graph-fixture', throughEventId=max(event['eventId'] for event in selected), events=selected)))
                await page.route('**/session-events?*', replay)
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                try:
                    await page.goto(url, wait_until='domcontentloaded')
                    await expect(page.get_by_role('button', name='Monitor main session', exact=True)).to_be_visible()
                    await page.get_by_role('button', name='Graph', exact=True).click()
                    await page.wait_for_function('window.__graphLabels.size === 4')
                    cdp = await context.new_cdp_session(page)
                    await check(page, cdp)
                    assert not errors, f'Browser errors: {errors}'
                    print('PASS', width, check.__name__, flush=True)
                except Exception as error:
                    await page.screenshot(path=f'/tmp/branchline-graph-{width}-{check.__name__}.png')
                    failures.append(f'{width}/{check.__name__}')
                    print('FAIL', width, check.__name__, str(error).split('Call log:')[0].strip(), flush=True)
                finally:
                    await context.close()
        await browser.close()
    if failures:
        raise SystemExit(f'{len(failures)} graph checks failed: {", ".join(failures)}')


if __name__ == '__main__':
    asyncio.run(main())
