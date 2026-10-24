# Branchline fork modifications; see FORK.md.
"""Check global spend navigation and loading on phone and desktop."""
import asyncio,json,os,re,sys,time
from urllib.parse import urlparse,parse_qs
from playwright.async_api import async_playwright,expect


def overview(provider='all',indexing=False):
    now=int(time.time()*1000)
    tokens=dict(inputTokens=100,outputTokens=100,cacheReadTokens=100,cacheWriteTokens=100,cacheWrite1hTokens=0,reasoningTokens=0)
    a=dict(id='saved-claude',label='Editor specification',runtime='claude',provider='anthropic',historical=True,project='superglm',status='completed',startTime=now-86400000,lastActivityTime=now-60000)
    b=dict(a,id='saved-codex',label='Inference suite',runtime='codex',provider='openai',project='superlss')
    rows=[dict(session=a,indexed=not indexing,knownCostUSD=90,unpricedResponses=0,records=3,agentCount=2),dict(session=b,indexed=not indexing,knownCostUSD=10,unpricedResponses=1,records=2,agentCount=1)]
    if provider!='all': rows=[r for r in rows if r['session']['provider']==provider]
    amount=0 if indexing else sum(r['knownCostUSD'] for r in rows)
    unknown=0 if indexing else sum(r['unpricedResponses'] for r in rows)
    parts=dict(input=amount*.2,output=amount*.4,cacheRead=amount*.1,cacheWrite=amount*.3,unattributed=0)
    models=[dict(id=json.dumps(['claude-opus-5-5','xhigh'],separators=(',',':')),model='claude-opus-5-5',reasoningEffort='xhigh',knownCostUSD=90,unpricedResponses=0,records=3,sessions=1),dict(id=json.dumps(['gpt-6.1-sol','ultra'],separators=(',',':')),model='gpt-6.1-sol',reasoningEffort='ultra',knownCostUSD=10,unpricedResponses=1,records=2,sessions=1)]
    return dict(status=dict(state='indexing' if indexing else 'ready',processed=0 if indexing else 2,total=2,indexed=0 if indexing else 2,updatedAt=now),window=dict(start=None,end=now),totals=dict(knownCostUSD=amount,unpricedResponses=unknown,untimedResponses=0,untimedKnownCostUSD=0,records=0 if indexing else sum(r['records'] for r in rows),breakdownUSD=parts,tokens=tokens),days=[dict(day='2026-10-21',knownCostUSD=amount,breakdownUSD=parts,unpricedResponses=unknown,records=5)],providers=[dict(provider=p,sessions=1,knownCostUSD=v,unpricedResponses=0,records=3) for p,v in [('anthropic',90),('openai',10)]],models=models,sessions=rows)


async def navigation(page):
    requests=[]
    async def route(r):
        requests.append(r.request.url)
        await r.fulfill(status=200,content_type='application/json',body=json.dumps(overview()))
    await page.route('**/spend-overview*',route)
    assert not requests
    await page.get_by_role('button',name='All session costs',exact=True).click()
    dashboard=page.get_by_role('dialog',name='All session costs',exact=True)
    await expect(dashboard).to_be_visible()
    await expect(dashboard.get_by_label('Global spend',exact=True)).to_have_text('$100.00')
    await expect(dashboard).to_contain_text('1 unpriced')
    await expect(dashboard.get_by_role('img',name='Spend per day',exact=True)).to_be_visible()
    await dashboard.get_by_text('Breakdowns · source, model and reasoning',exact=True).click()
    await expect(dashboard.get_by_role('button',name='Open costs for Editor specification',exact=True)).to_be_visible()
    assert await dashboard.evaluate('e=>e.scrollWidth<=e.clientWidth')
    await dashboard.get_by_role('button',name='Open costs for Editor specification',exact=True).click()
    await expect(dashboard).to_have_count(0)
    detail=page.get_by_role('region',name='Session API costs',exact=True)
    await expect(detail).to_be_visible()
    await expect(detail.get_by_role('tab',name='Spend',exact=True)).to_have_attribute('aria-selected','true')
    await expect(detail.get_by_label('Chart headline',exact=True)).to_have_text('$90.00')
    await detail.get_by_role('button',name='Back to all costs',exact=True).click()
    await expect(dashboard).to_be_visible()
    await expect(dashboard.locator('details')).to_have_attribute('open','')
    await dashboard.get_by_role('button',name='Close all costs',exact=True).click()
    await expect(page.get_by_role('button',name='All session costs',exact=True)).to_be_focused()


async def filtering(page):
    gate=asyncio.Event()
    async def route(r):
        q=parse_qs(urlparse(r.request.url).query)
        provider=q.get('provider',['all'])[0]
        if provider=='anthropic': await gate.wait()
        await r.fulfill(status=200,content_type='application/json',body=json.dumps(overview(provider)))
    await page.route('**/spend-overview*',route)
    await page.get_by_role('button',name='All session costs',exact=True).click()
    panel=page.get_by_role('dialog',name='All session costs',exact=True)
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('$100.00')
    await panel.get_by_role('button',name='Anthropic',exact=True).click()
    await expect(panel.get_by_label('Global spend',exact=True)).not_to_have_text('$100.00')
    gate.set()
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('$90.00')
    await expect(panel.get_by_role('button',name='Open costs for Inference suite',exact=True)).to_have_count(0)
    await panel.get_by_role('searchbox',name='Search session costs',exact=True).fill('nonexistent')
    await expect(panel.get_by_text('No sessions match your search.',exact=True)).to_be_visible()
    await panel.get_by_role('searchbox',name='Search session costs',exact=True).fill('SUPERGLM')
    await expect(panel.get_by_role('button',name='Open costs for Editor specification',exact=True)).to_be_visible()
    await panel.get_by_role('button',name='Open costs for Editor specification',exact=True).click()
    await page.get_by_role('button',name='Back to all costs',exact=True).click()
    await expect(panel.get_by_role('button',name='Anthropic',exact=True)).to_have_attribute('aria-pressed','true')
    await expect(panel.get_by_role('searchbox',name='Search session costs',exact=True)).to_have_value('SUPERGLM')
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('$90.00')
    if page.viewport_size['width']==390: await page.screenshot(path='/tmp/branchline-global-spend-phone.png')


async def indexing(page):
    ready=False
    progress=asyncio.Event()
    status_calls=[]
    async def route(r):
        q=parse_qs(urlparse(r.request.url).query)
        data=overview(indexing=not ready)
        if q.get('status')==['1']:
            status_calls.append(1);data=dict(status=data['status'])
            if not ready:
                data['status'].update(indexed=1,processed=1)
                progress.set()
        await r.fulfill(status=200,content_type='application/json',body=json.dumps(data))
    await page.route('**/spend-overview*',route)
    await page.get_by_role('button',name='All session costs',exact=True).click()
    panel=page.get_by_role('dialog',name='All session costs',exact=True)
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('—')
    await expect(panel).to_contain_text('Indexing')
    await expect(panel.get_by_role('button',name='Open costs for Editor specification',exact=True)).to_contain_text('Pending')
    await asyncio.wait_for(progress.wait(),timeout=8)
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('—')
    ready=True
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('$100.00',timeout=8000)
    assert status_calls,'Progress should use lightweight status requests'
    await panel.get_by_role('button',name='Close all costs',exact=True).click()
    before=len(status_calls)
    await page.wait_for_timeout(2300)
    assert len(status_calls)==before,'Closed dashboard keeps polling'


async def retry(page):
    calls=[]
    async def route(r):
        calls.append(1)
        await r.fulfill(status=503 if len(calls)==1 else 200,content_type='application/json',body=json.dumps(overview()))
    await page.route('**/spend-overview*',route)
    await page.get_by_role('button',name='All session costs',exact=True).click()
    panel=page.get_by_role('dialog',name='All session costs',exact=True)
    await expect(panel.get_by_role('alert')).to_be_visible()
    await panel.get_by_role('button',name='Retry spend dashboard',exact=True).click()
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('$100.00')
    assert len(calls)==2


async def periods_models(page):
    queries=[]
    async def route(r):
        q=parse_qs(urlparse(r.request.url).query);queries.append(q)
        await r.fulfill(status=200,content_type='application/json',body=json.dumps(overview('anthropic' if q.get('model') else 'all')))
    await page.route('**/spend-overview*',route)
    await page.get_by_role('button',name='All session costs',exact=True).click()
    panel=page.get_by_role('dialog',name='All session costs',exact=True)
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('$100.00')
    for label,days in [('Today',0),('7 days',6),('30 days',29)]:
        async with page.expect_response(lambda response:'/spend-overview?' in response.url):
            await panel.get_by_role('button',name=label,exact=True).click()
        expected=await page.evaluate('(days)=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-days);return +d}',days)
        assert queries[-1].get('start')==[str(expected)],queries[-1]
        assert 'end' not in queries[-1],'Use server-now to avoid a frozen boundary during indexing'
    await panel.get_by_text('Breakdowns · source, model and reasoning',exact=True).click()
    await panel.get_by_role('button',name=re.compile(r'^Filter all costs for .* · xhigh$')).click()
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('$90.00')
    assert json.loads(queries[-1]['model'][0])==['claude-opus-5-5','xhigh']
    await panel.get_by_role('button',name=re.compile('^Clear model filter')).click()
    await expect(panel.get_by_label('Global spend',exact=True)).to_have_text('$100.00')


async def main():
    url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:3001'
    selected=set(sys.argv[2].split(',')) if len(sys.argv)>2 else None
    failures=[]
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True,executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),args=['--no-sandbox'])
        for width in [360,390,1280]:
            for check in [navigation,filtering,indexing,retry,periods_models]:
                if selected and check.__name__ not in selected:continue
                context=await b.new_context(viewport=dict(width=width,height=844),is_mobile=width<640,has_touch=width<640,timezone_id='Europe/Istanbul')
                page=await context.new_page();page.set_default_timeout(3000)
                errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                sid='phone-primary';now=int(time.time()*1000)
                events=[dict(type='agent_spawn',payload=dict(name='Orchestrator',isMain=True),time=0,sessionId=sid,eventId=1,streamId='spend-fixture')]
                stream=''.join('data: '+json.dumps(packet)+'\n\n' for packet in [dict(type='session-list',sessions=[dict(id=sid,label='Current session',status='active',startTime=now,lastActivityTime=now)]),dict(type='agent-event-batch',events=events)])
                await page.route('**/events*',lambda r:r.fulfill(status=200,content_type='text/event-stream',body=stream))
                await page.route('**/session-events?*',lambda r:r.fulfill(status=200,content_type='application/json',body=json.dumps(dict(streamId='spend-fixture',throughEventId=0,events=[]))))
                await page.route('**/session-cost-history?*',lambda r:r.fulfill(status=200,content_type='application/json',body=json.dumps(dict(sessionId='saved-claude',history=dict(points=[dict(timestamp=now-1000,costUSD=90)],totalCostUSD=90,untimedCostUSD=0,unpricedResponses=0,groups=[])))))
                try:
                    await page.goto(url,wait_until='domcontentloaded')
                    await check(page)
                    assert not errors,errors
                    print('PASS',width,check.__name__,flush=True)
                except Exception as e:
                    failures.append((width,check.__name__))
                    print('FAIL',width,check.__name__,str(e).split('Call log:')[0],flush=True)
                    await page.screenshot(path=f'/tmp/branchline-spend-failed-{width}-{check.__name__}.png')
                finally:await context.close()
        await b.close()
    if failures:raise SystemExit(f'{len(failures)} spend dashboard checks failed: {failures}')
asyncio.run(main())
