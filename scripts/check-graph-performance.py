# Branchline fork modifications; see FORK.md.
"""Cold-history and render-work regressions, using real canvas and mobile input.

uvx --from playwright python scripts/check-graph-performance.py URL [check,...]
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
from urllib.parse import parse_qs, urlparse
from playwright.async_api import async_playwright, expect

HISTORY = int(os.environ.get('BRANCHLINE_GRAPH_HISTORY', '1000'))

spec=importlib.util.spec_from_file_location('graph_checks', Path(__file__).with_name('check-phone-graph.py'))
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

CAPTURE=base.CAPTURE+'''
window.__historyLabels=0;window.__graphFrames=0;window.__gridLines=0;window.__previousGridLines=0;
const textDraw=CanvasRenderingContext2D.prototype.fillText;
CanvasRenderingContext2D.prototype.fillText=function(text,...args){
  if(this.canvas.isConnected&&String(text).startsWith('H'))window.__historyLabels++;
  return textDraw.call(this,text,...args);
};
const line=CanvasRenderingContext2D.prototype.lineTo;
CanvasRenderingContext2D.prototype.lineTo=function(...args){if(this.canvas.isConnected)window.__gridLines++;return line.apply(this,args)};
const clear=CanvasRenderingContext2D.prototype.clearRect;
CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.isConnected){window.__previousGridLines=window.__gridLines;window.__gridLines=0;window.__graphFrames++;}return clear.apply(this,args)};
'''

def fixture():
    sessions,active=base.fixture()
    usage=dict(inputTokens=100,outputTokens=10,cacheReadTokens=0,cacheWriteTokens=0,cacheWrite1hTokens=0,reasoningTokens=0,totalTokens=110,costUSD=.5)
    events=[active[0]]
    for i in range(HISTORY):events.append(dict(type='agent_spawn',payload=dict(name=f'History {i}',parent='Root')))
    for i in range(HISTORY):
        events.extend([dict(type='context_update',payload=dict(agent=f'History {i}',tokens=100,usage=usage)),dict(type='agent_complete',payload=dict(name=f'History {i}'))])
    events+=active[1:]
    for i,event in enumerate(events):event.update(time=i/10,eventId=i+1,sessionId='graph-fixture',streamId='graph-fixture')
    return sessions,events

async def cold_history_draws_only_live_agents(page):
    await expect(page.get_by_role('region',name='Agent controls')).to_contain_text(f'{HISTORY+4} agents')
    await base.settled(page)
    assert await page.evaluate('window.__historyLabels')==0,'Finished history was sent to canvas on load'
    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    await expect(page.get_by_role('region',name='Agent controls')).to_contain_text(f'~${HISTORY*.5:.2f} API')
    await page.get_by_role('button',name='Tree',exact=True).click()
    await page.get_by_role('button',name='Show all agents',exact=True).click()
    await expect(page.get_by_text('History 0',exact=True)).to_be_visible()

async def reactivation_updates_graph_without_reintroducing_history(page):
    await base.settled(page)
    events=[dict(type='agent_spawn',payload=dict(name='History 0',parent='Root')),dict(type='agent_complete',payload=dict(name='Z'))]
    for i,e in enumerate(events):e.update(time=1000,eventId=5000+i,sessionId='graph-fixture',streamId='graph-fixture')
    await page.evaluate("events=>window.postMessage({type:'agent-event-batch',events},'*')",events)
    # History 0 becomes live again; a completed parent must not hide independent Y/X.
    await page.wait_for_function('window.__historyLabels>0')
    await expect(page.get_by_role('region',name='Agent controls')).to_contain_text(f'~${HISTORY*.5:.2f} API')
    await page.screenshot(path=f'/tmp/branchline-graph-reactivated-{page.viewport_size["width"]}.png')
    before=await page.evaluate('window.__historyLabels')
    done=dict(type='agent_complete',payload=dict(name='History 0'),time=1001,eventId=5002,sessionId='graph-fixture',streamId='graph-fixture')
    await page.evaluate("event=>window.postMessage({type:'agent-event-batch',events:[event]},'*')",done)
    await base.frames(page,30)
    stable=await page.evaluate('window.__historyLabels')
    await base.frames(page,15)
    assert await page.evaluate('window.__historyLabels')==stable,'Completed agent keeps drawing after completion'
    assert stable>=before

async def mobile_canvas_limits_pixel_work(page):
    canvas=page.locator('canvas')
    # The usage header can wrap after replay. Wait for ResizeObserver and the
    # next draw to resize the backing store to the final CSS height.
    await page.wait_for_function('''() => {
      const c=document.querySelector('canvas'), box=c?.getBoundingClientRect();
      return box&&c.width<=Math.round(box.width*2)&&c.height<=Math.round(box.height*2);
    }''')
    pixels=await canvas.evaluate('(c)=>({width:c.width,height:c.height,cssWidth:c.getBoundingClientRect().width,cssHeight:c.getBoundingClientRect().height})')
    assert pixels['width']<=round(pixels['cssWidth']*2),f'Phone canvas exceeds DPR 2: {pixels}'
    assert pixels['height']<=round(pixels['cssHeight']*2),f'Phone canvas exceeds DPR 2: {pixels}'

async def zoomed_out_grid_has_bounded_work(page):
    await base.settled(page)
    await page.locator('canvas').hover(position=dict(x=15,y=200))
    await page.keyboard.down('Control')
    for _ in range(20):await page.mouse.wheel(0,100)
    await page.keyboard.up('Control')
    await base.frames(page,6)
    lines=await page.evaluate('window.__previousGridLines')
    assert 0<lines<2000,f'Zoom-out renders a dense world-sized grid: {lines} path segments/frame'

async def main():
    url=sys.argv[1]if len(sys.argv)>1 else'http://127.0.0.1:3001'
    requested=set(sys.argv[2].split(','))if len(sys.argv)>2 else None
    failures=[]
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'),args=['--no-sandbox'])
        for width in [360,390,1280]:
            for check in [cold_history_draws_only_live_agents,reactivation_updates_graph_without_reintroducing_history,mobile_canvas_limits_pixel_work,zoomed_out_grid_has_bounded_work]:
                if requested and check.__name__ not in requested:continue
                if width==1280 and check is mobile_canvas_limits_pixel_work:continue
                context=await browser.new_context(viewport=dict(width=width,height=844),is_mobile=width<640,has_touch=width<640,device_scale_factor=2.75)
                page=await context.new_page();page.set_default_timeout(15000)
                await page.add_init_script(CAPTURE)
                sessions,events=fixture();release=asyncio.Event()
                stream='data: '+json.dumps(dict(type='session-list',sessions=sessions))+'\n\n'
                await page.route('**/events*',lambda r:r.fulfill(status=200,content_type='text/event-stream',body=stream))
                async def replay(route):
                    await release.wait()
                    await route.fulfill(status=200,content_type='application/json',body=json.dumps(dict(streamId='graph-fixture',throughEventId=len(events),events=events)))
                await page.route('**/session-events?*',replay)
                errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                try:
                    await page.goto(url,wait_until='domcontentloaded')
                    await page.get_by_role('button',name='Graph',exact=True).click()
                    release.set()
                    await expect(page.get_by_role('region',name='Agent controls')).to_contain_text(f'{HISTORY+4} agents')
                    await page.wait_for_function('window.__graphLabels.size===4')
                    await check(page)
                    assert not errors,errors
                    print('PASS',width,check.__name__,flush=True)
                except Exception as e:
                    failures.append(f'{width}/{check.__name__}')
                    print('FAIL',width,check.__name__,str(e).split('Call log:')[0].strip(),flush=True)
                    try:await page.screenshot(path=f'/tmp/branchline-graph-stress-{width}-{check.__name__}.png',timeout=2000)
                    except Exception:pass
                finally:
                    release.set();await context.close()
        await browser.close()
    if failures:raise SystemExit(f'{len(failures)} graph stress checks failed: '+', '.join(failures))

if __name__=='__main__':asyncio.run(main())
