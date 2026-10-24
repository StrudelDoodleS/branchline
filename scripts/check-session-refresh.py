"""Branchline fork: real HTTP/1 refresh, visibility and recovery checks with synthetic sessions."""
import asyncio
import datetime
import json
import os
import sys
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs
from playwright.async_api import async_playwright, expect

NOW = 1792828800000
VISIBILITY = '''window.__refreshHidden=false;
Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__refreshHidden});
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__refreshHidden?'hidden':'visible'});
window.__refreshSources=[];const NativeSource=window.EventSource;
window.EventSource=class extends NativeSource{constructor(...args){super(...args);window.__refreshSources.push(this)}};
window.__refreshVisible=value=>{window.__refreshHidden=!value;document.dispatchEvent(new Event('visibilitychange'))};'''


class Fixture:
    def __init__(self, assets):
        self.assets = assets
        self.replays = 0
        self.legacy_batches = 0
        self.revision = 0
        self.gate = threading.Event()
        self.gate.set()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_args):
                pass

            def do_GET(self):
                url = urlsplit(self.path)
                query = parse_qs(url.query)
                try:
                    if url.path in fixture.assets:
                        data, mime = fixture.assets[url.path]
                    elif url.path == '/events':
                        self.send_response(200)
                        self.send_header('Content-Type', 'text/event-stream')
                        self.send_header('Cache-Control', 'no-store')
                        self.end_headers()
                        packets = [dict(type='session-list', sessions=fixture.sessions())]
                        if query.get('replay') != ['0']:
                            fixture.legacy_batches += 1
                            packets.append(dict(type='agent-event-batch', events=fixture.events('refresh-main')))
                        self.wfile.write(''.join('data: '+json.dumps(packet)+'\n\n' for packet in packets).encode())
                        self.wfile.flush()
                        self.connection.settimeout(30)
                        self.connection.recv(1)
                        self.close_connection = True
                        return
                    elif url.path == '/session-events':
                        fixture.replays += 1
                        fixture.gate.wait(timeout=25)
                        sid = query['sessionId'][0]
                        data = json.dumps(dict(streamId='refresh-fixture', throughEventId=fixture.revision+4, events=fixture.events(sid))).encode()
                        mime = 'application/json'
                    elif url.path == '/session-catalog':
                        data, mime = json.dumps(dict(sessions=fixture.catalog() if hasattr(fixture, 'catalog') else fixture.sessions())).encode(), 'application/json'
                    else:
                        self.send_response(404)
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                    self.send_response(200)
                    self.send_header('Content-Type', mime)
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, TimeoutError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def sessions(self):
        return [dict(id=sid, label=name, runtime='claude', provider='anthropic', status='active', startTime=NOW,
                     lastActivityTime=NOW-offset) for sid, name, offset in [('refresh-main', 'Refresh main', 0), ('refresh-other', 'Refresh other', 1000)]]

    def events(self, sid):
        payloads = [('agent_spawn', dict(name='orchestrator', isMain=True, runtime='claude')),
                    ('agent_spawn', dict(name='Worker', parent='orchestrator', model='claude-sonnet-5-5')),
                    ('context_update', dict(agent='Worker', tokens=222 if self.revision else 111, tokensMax=1000)),
                    ('message', dict(agent='Worker', role='assistant', content='Returned activity snapshot' if self.revision else 'Initial activity snapshot'))]
        return [dict(type=kind, payload=payload, time=i, sessionId=sid, streamId='refresh-fixture', eventId=self.revision+i+1)
                for i, (kind, payload) in enumerate(payloads)]

    def close(self):
        self.gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


async def ready(page):
    await page.get_by_role('button', name='Monitor Worker', exact=True).wait_for(timeout=4000)
    await expect(page.get_by_text('Loading recent activity…', exact=True)).not_to_be_visible(timeout=4000)


async def tabs(browser, fixture):
    context = await browser.new_context(viewport=dict(width=390, height=844), is_mobile=True, has_touch=True)
    await context.add_init_script(VISIBILITY)
    pages = []
    try:
        for i in range(6):
            if pages:
                await pages[-1].evaluate('window.__refreshVisible(false)')
            page = await context.new_page()
            pages.append(page)
            await page.goto(fixture.url, wait_until='domcontentloaded', timeout=5000)
            await ready(page)
        open_sources = sum([await page.evaluate('window.__refreshSources.filter(s=>s.readyState!==2).length') for page in pages])
        assert open_sources == 1, f'Hidden tabs retained {open_sources} streams'
        await pages[0].reload(wait_until='domcontentloaded', timeout=5000)
        await ready(pages[0])
        print('PASS six tabs release hidden streams and reload without connection starvation', flush=True)
    finally:
        await context.close()


async def resume(browser, fixture):
    context = await browser.new_context(viewport=dict(width=390, height=844))
    await context.add_init_script(VISIBILITY)
    page = await context.new_page()
    try:
        await page.goto(fixture.url, wait_until='domcontentloaded')
        await ready(page)
        assert fixture.legacy_batches == 0, 'Refresh still downloaded the same history over SSE and HTTP'
        await page.evaluate('window.__refreshVisible(false)')
        fixture.revision = 1000
        before = fixture.replays
        await page.evaluate('window.__refreshVisible(true)')
        await ready(page)
        await page.get_by_role('button', name='Monitor Worker', exact=True).click()
        await expect(page.get_by_role('log', name='Agent messages')).to_contain_text('Returned activity snapshot')
        assert fixture.replays > before
        print('PASS live-only startup and fresh session replay after returning from background', flush=True)
    finally:
        await context.close()


async def stalled(browser, fixture):
    context = await browser.new_context(viewport=dict(width=390, height=844))
    await context.add_init_script(VISIBILITY)
    page = await context.new_page()
    await page.clock.install(time=datetime.datetime.fromtimestamp(NOW/1000, datetime.timezone.utc))
    fixture.gate.clear()
    try:
        await page.goto(fixture.url, wait_until='domcontentloaded')
        await expect(page.get_by_text('Loading recent activity…', exact=True)).to_be_visible()
        await page.clock.fast_forward(16000)
        await expect(page.get_by_role('alert')).to_contain_text('timed out')
        fixture.gate.set()
        await page.get_by_role('button', name='Retry', exact=True).click()
        await ready(page)
        await expect(page.get_by_role('alert')).to_have_count(0)
        print('PASS stalled history load times out and retries successfully', flush=True)
    finally:
        fixture.gate.set()
        await context.close()


async def open_sessions(browser, fixture):
    rows = [dict(id=sid, label=label, status=status, open=opened, runtime=runtime,
                 provider='anthropic' if runtime == 'claude' else 'openai', startTime=NOW-3600000,
                 lastActivityTime=NOW-i*60000)
            for i, (sid, label, status, opened, runtime) in enumerate([
                ('refresh-main', 'Credibility transformer for GAMs', 'completed', True, 'claude'),
                ('refresh-other', 'Splitting giant functions audit', 'active', True, 'claude'),
                ('codex-main', 'Install AgentHUD from GitHub', 'active', False, 'codex'),
                ('codex-hybrid', 'Explore hybrid tabular predictors', 'active', False, 'codex'),
                ('finished-review', 'Review the changes between origin/master and HEAD', 'completed', False, 'codex'),
            ])]
    fixture.sessions = lambda: rows
    fixture.catalog = lambda: [dict(row, historical=True, status='completed', label='Old saved title') for row in rows]
    context = await browser.new_context(viewport=dict(width=390, height=844), is_mobile=True, has_touch=True)
    await context.add_init_script(VISIBILITY)
    page = await context.new_page()
    await page.clock.install(time=datetime.datetime.fromtimestamp(NOW/1000, datetime.timezone.utc))
    try:
        await page.goto(fixture.url, wait_until='domcontentloaded')
        await ready(page)
        await page.get_by_role('button', name='Browse sessions', exact=True).click()
        panel = page.get_by_role('dialog', name='Sessions', exact=True)
        active = panel.locator('[data-session-group="active"]')
        await expect(active.locator('[data-session-group-count]')).to_have_text('4')
        await active.locator('[data-session-group-toggle]').click()
        waiting = active.locator('[data-session-choice="refresh-main"]')
        await expect(waiting).to_contain_text('Credibility transformer for GAMs')
        await expect(waiting).to_contain_text('Waiting')
        await page.evaluate("session=>window.postMessage({type:'session-updated',sessionId:session.id,label:session.label,session},'*')", dict(rows[0], status='active'))
        await expect(waiting).to_contain_text('Working')
        await page.evaluate("session=>window.postMessage({type:'session-updated',sessionId:session.id,label:session.label,session},'*')", rows[0])
        await expect(waiting).to_contain_text('Waiting')
        await expect(active.locator('[data-session-group-count]')).to_have_text('4')
        await expect(panel.locator('[data-session-group="recent"] [data-session-choice="finished-review"]')).to_have_count(1)
        await page.evaluate("session=>window.postMessage({type:'session-updated',sessionId:session.id,label:session.label,session},'*')", dict(rows[0], open=False))
        await expect(active.locator('[data-session-group-count]')).to_have_text('3')
        await expect(panel.locator('[data-session-group="recent"] [data-session-choice="refresh-main"]')).to_have_count(1)
        print('PASS open Claude mains keep native names and stay Active between turns until closed', flush=True)
    finally:
        await context.close()


async def main():
    assets = {}
    for path, mime in [('/', 'text/html'), ('/index.js', 'application/javascript'), ('/index.css', 'text/css')]:
        with urllib.request.urlopen(sys.argv[1].rstrip('/')+path, timeout=20) as response:
            assets[path] = response.read(), mime
    selected = set(sys.argv[2].split(',')) if len(sys.argv) > 2 else None
    failures = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE'])
        for check in [tabs, resume, stalled, open_sessions]:
            if selected and check.__name__ not in selected:
                continue
            fixture = Fixture(assets)
            try:
                await check(browser, fixture)
            except Exception as error:
                failures.append(check.__name__)
                print('FAIL', check.__name__, str(error).split('Call log:')[0], flush=True)
                traceback.print_exc()
            finally:
                fixture.close()
        await browser.close()
    if failures:
        raise SystemExit('Failed refresh checks: '+', '.join(failures))


asyncio.run(main())
