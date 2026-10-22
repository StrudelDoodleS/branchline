# Branchline fork modifications; see FORK.md.
"""Measure and check rendering work with a stable live-session fixture."""
import asyncio,json,os,re,sys,time
from playwright.async_api import async_playwright,expect

INSTRUMENT=r'''(() => {
 window.__work={raf:0,draws:0,blurs:0};
 const raf=window.requestAnimationFrame.bind(window);
 window.requestAnimationFrame=callback=>raf(time=>{window.__work.raf++;callback(time)});
 const clear=CanvasRenderingContext2D.prototype.clearRect;
 CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.isConnected)window.__work.draws++;return clear.apply(this,args)};
 const image=CanvasRenderingContext2D.prototype.drawImage;
 CanvasRenderingContext2D.prototype.drawImage=function(...args){if(this.filter!=='none')window.__work.blurs++;return image.apply(this,args)};
 const sources=[];window.__sources=sources;
 window.EventSource=class extends EventTarget {
  constructor(){super();this.readyState=0;sources.push(this);setTimeout(()=>{if(this.readyState===2)return;this.readyState=1;this.onopen?.(new Event('open'));window.__packets.forEach(packet=>this.onmessage?.({data:JSON.stringify(packet)}))},0)}
  close(){this.readyState=2}
 };
 window.__hide=hidden=>{
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>hidden?'hidden':'visible'});
  document.dispatchEvent(new Event('visibilitychange'));
 };
})();'''

async def measure(page,cdp,seconds=3):
 await page.evaluate('window.__work={raf:0,draws:0,blurs:0}')
 before={m['name']:m['value'] for m in (await cdp.send('Performance.getMetrics'))['metrics']}
 await page.wait_for_timeout(seconds*1000)
 after={m['name']:m['value'] for m in (await cdp.send('Performance.getMetrics'))['metrics']}
 work=await page.evaluate('window.__work')
 return dict(work,task_ms=round((after['TaskDuration']-before['TaskDuration'])*1000,1),script_ms=round((after['ScriptDuration']-before['ScriptDuration'])*1000,1),seconds=seconds)

async def run():
 url=sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:3001'
 profile='--profile' in sys.argv
 selected=next((set(value.split('=',1)[1].split(',')) for value in sys.argv if value.startswith('--cases=')),None)
 results={};failures=[]
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path=os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE'],args=['--no-sandbox'])
  for case in ['tree','graph','covered_graph','covered_events','phone_cost','hidden','resume']:
   if selected and case not in selected:continue
   context=await browser.new_context(viewport=dict(width=390,height=844),device_scale_factor=2.75,is_mobile=True,has_touch=True)
   page=await context.new_page();page.set_default_timeout(10000)
   now=int(time.time()*1000);sid='power-fixture'
   sessions=[dict(id=sid,label='Power regression',runtime='claude',provider='anthropic',status='active',startTime=now,lastActivityTime=now)]
   events=[dict(type='agent_spawn',payload=dict(name='Root' if i==0 else f'Worker {i}',isMain=i==0,parent=None if i==0 else 'Root',runtime='claude'),sessionId=sid,time=i/100,eventId=i+1,streamId=sid) for i in range(24)]
   packets=[dict(type='session-list',sessions=sessions),dict(type='agent-event-batch',events=events)]
   await page.add_init_script('window.__packets='+json.dumps(packets)+';'+INSTRUMENT)
   await page.route('**/session-events?*',lambda r:r.fulfill(status=200,content_type='application/json',body=json.dumps(dict(events=events,throughEventId=len(events),streamId=sid))))
   empty=dict(input=0,output=0,cacheRead=0,cacheWrite=0,unattributed=0)
   overview=dict(status=dict(state='ready',processed=1,total=1,indexed=1),window=dict(start=None,end=now),totals=dict(knownCostUSD=10,records=1,unpricedResponses=0,untimedResponses=0,untimedKnownCostUSD=0,breakdownUSD=empty),providers=[],models=[],days=[],sessions=[])
   await page.route('**/spend-overview*',lambda r:r.fulfill(status=200,content_type='application/json',body=json.dumps(overview)))
   history=dict(points=[],burnRate=dict(points=[],bucketMs=3600000),totalCostUSD=10,untimedCostUSD=0,unpricedResponses=0,groups=[])
   await page.route('**/session-cost-history?*',lambda r:r.fulfill(status=200,content_type='application/json',body=json.dumps(dict(sessionId=sid,history=history))))
   try:
    await page.goto(url,wait_until='domcontentloaded')
    await expect(page.get_by_role('button',name='Monitor main session',exact=True)).to_be_visible()
    if case!='tree':
     await page.get_by_role('button',name='Graph',exact=True).click()
     await expect(page.get_by_role('button',name='Fit graph',exact=True)).to_be_visible()
    await page.wait_for_timeout(1500)
    cdp=await context.new_cdp_session(page);await cdp.send('Performance.enable')
    clock=page.locator('.glass-card span').filter(has_text=re.compile(r'^\d+:\d\d$')).first
    before_clock=await clock.text_content()
    if case in ['covered_graph','covered_events']:
     await page.get_by_role('button',name='All session costs',exact=True).click()
     await expect(page.get_by_role('dialog',name='All session costs',exact=True)).to_be_visible()
    if case=='covered_events':
     await page.evaluate('''() => {
      const original=Array.prototype.slice;let armed=true;
      const usage=cost=>({inputTokens:100,outputTokens:100,cacheReadTokens:0,cacheWriteTokens:0,cacheWrite1hTokens:0,reasoningTokens:0,totalTokens:200,costUSD:cost});
      const event=(id,cost)=>({type:'context_update',payload:{agent:'Root',tokens:200,usage:usage(cost)},time:2,sessionId:'power-fixture',streamId:'power-fixture',eventId:id});
      const send=event=>window.dispatchEvent(new MessageEvent('message',{data:{type:'agent-event-batch',events:[event]}}));
      Array.prototype.slice=function(...args){
       const result=original.apply(this,args);
       if(armed&&this[0]?.eventId===100&&this[0]?.type==='context_update'){
        armed=false;Array.prototype.slice=original;queueMicrotask(()=>send(event(101,2)));
       }
       return result;
      };
      send(event(100,1));
     }''')
     await expect(page.locator('[aria-label="Agent controls"]')).to_contain_text('$2.00')
    if case=='phone_cost':
     await page.get_by_role('button',name='$Cost',exact=True).click()
     await expect(page.get_by_role('region',name='Session API costs',exact=True)).to_be_visible()
    if case in ['hidden','resume']:await page.evaluate('window.__hide(true)')
    await page.wait_for_timeout(250)
    result=await measure(page,cdp);results[case]=result
    print(json.dumps(dict(case=case,**result)),flush=True)
    if not profile:
     if case=='tree':assert result['raf']<=20,'The file tree keeps running an animation-frame loop'
     if case=='graph':
      assert 10<=result['draws']<=110,'Phone graph should draw at most 30 resting frames/sec'
      assert result['blurs']<=result['draws'],'Phone graph repeats expensive blur passes per frame'
     if case in ['covered_graph','covered_events','phone_cost','hidden','resume']:assert result['draws']==0,'Covered/hidden graph keeps drawing'
     if case in ['hidden','resume']:assert result['raf']==0,'Hidden simulation keeps requesting animation frames'
    if case=='resume':
     await page.evaluate('window.__hide(false)')
     await page.wait_for_timeout(100)
     after=await measure(page,cdp,1)
     assert after['draws']>0,'Graph does not resume rendering'
     assert await page.evaluate('window.__sources.filter(s=>s.readyState===1).length')==1,'Resume must have exactly one live stream'
     current=await clock.text_content()
     seconds=lambda text:sum(int(part)*unit for part,unit in zip(text.split(':'),[60,1]))
     assert seconds(current)-seconds(before_clock)>=3,'Hidden elapsed time was discarded'
     await page.get_by_role('button',name='Tree',exact=True).click()
     await expect(page.get_by_role('button',name='Monitor Worker 23',exact=True)).to_be_visible()
    if case in ['covered_graph','covered_events']:
     await page.get_by_role('button',name='Close all costs',exact=True).click()
     resumed=await measure(page,cdp,1)
     assert resumed['draws']>0,'Closing All costs does not resume graph'
     current=await clock.text_content()
     seconds=lambda text:sum(int(part)*unit for part,unit in zip(text.split(':'),[60,1]))
     assert seconds(current)-seconds(before_clock)>=3,'Covered elapsed time was discarded'
   except Exception as e:
    failures.append(case);print('FAIL',case,str(e).split('Call log:')[0],flush=True)
   finally:await context.close()
  await browser.close()
 if failures:raise SystemExit('Power regressions: '+str(failures))
 print('POWER_CHECK_COMPLETE',json.dumps(results),flush=True)

asyncio.run(run())
