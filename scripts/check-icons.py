# Branchline fork modifications; see FORK.md.
"""Verify the built browser/phone icons: uvx --from playwright python scripts/check-icons.py URL."""
import asyncio
import os
import sys
from urllib.parse import urljoin
from playwright.async_api import async_playwright, expect


async def main():
    base = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3001').rstrip('/') + '/'
    async with async_playwright() as p:
        launch = dict(headless=True, args=['--no-sandbox'])
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
            launch['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        browser = await p.chromium.launch(**launch)
        for width, dpr in [(360, 2), (390, 2.75), (1280, 1)]:
            context = await browser.new_context(viewport=dict(width=width, height=844), device_scale_factor=dpr,
                                                is_mobile=width < 640, has_touch=width < 640)
            page = await context.new_page()
            page.set_default_timeout(3000)
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.route('**/events', lambda route: route.fulfill(status=200, content_type='text/event-stream',
                body='data: {"type":"session-list","sessions":[]}\n\n'))
            response = await page.goto(base, wait_until='domcontentloaded')
            assert response and response.ok
            await expect(page).to_have_title('Branchline')
            links = [
                ('link[rel="icon"][type="image/svg+xml"]', 'image/svg+xml'),
                ('link[rel="icon"][sizes="32x32"]', 'image/png'),
                ('link[rel="shortcut icon"]', 'image/x-icon'),
                ('link[rel="apple-touch-icon"][sizes="180x180"]', 'image/png'),
                ('link[rel="manifest"]', 'application/manifest+json'),
            ]
            for selector, mime in links:
                link = page.locator(selector)
                await expect(link).to_have_count(1)
                href = urljoin(base, await link.get_attribute('href'))
                asset = await page.request.get(href)
                assert asset.ok and asset.headers.get('content-type') == mime, (href, asset.status, asset.headers)
                etag = asset.headers.get('etag')
                assert etag, href
                cached = await page.request.get(href, headers={'If-None-Match': etag})
                assert cached.status == 304 and not await cached.body(), href
            bookmark = await page.request.get(base+'?from=phone-shortcut')
            assert bookmark.ok and '<title>Branchline</title>' in await bookmark.text()
            manifest_url = urljoin(base, await page.locator('link[rel="manifest"]').get_attribute('href'))
            manifest = await (await page.request.get(manifest_url)).json()
            assert manifest['name'] == 'Branchline' and manifest['start_url'] == '/' and manifest['scope'] == '/'
            assert {(icon['sizes'], icon.get('purpose', 'any')) for icon in manifest['icons']} >= {
                ('192x192', 'any'), ('512x512', 'any'), ('512x512', 'maskable')}
            image_specs = [dict(url=icon['src'], size=int(icon['sizes'].split('x')[0]), opaque=True,
                                maskable=icon.get('purpose') == 'maskable') for icon in manifest['icons']]
            image_specs += [dict(url='/apple-touch-icon.png?v=1', size=180, opaque=True), dict(url='/icon-32.png?v=1', size=32)]
            checked = await page.evaluate('''async specs => {
                const results=[];
                for(const spec of specs){
                    const image=new Image();image.src=spec.url;await image.decode();
                    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
                    const context=canvas.getContext('2d');context.drawImage(image,0,0);
                    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
                    let transparent=0,cyan=0,violet=0,outside=0;
                    for(let offset=0;offset<pixels.length;offset+=4){
                        const [r,g,b,a]=pixels.slice(offset,offset+4);
                        if(a!==255)transparent++;
                        if(a>128&&g>150&&b>150&&r<g*.8)cyan++;
                        if(a>128&&r>120&&b>150&&b>g*1.2)violet++;
                        // W3C maskable safe zone: centered circle with radius 40% of the icon size.
                        if(spec.maskable&&a>128&&Math.max(Math.abs(r-15),Math.abs(g-23),Math.abs(b-42))>30){
                            const x=offset/4%canvas.width+.5-canvas.width/2;
                            const y=Math.floor(offset/4/canvas.width)+.5-canvas.height/2;
                            if(x*x+y*y>(.4*canvas.width)**2)outside++;
                        }
                    }
                    results.push({...spec,width:image.naturalWidth,height:image.naturalHeight,transparent,cyan,violet,outside});
                }
                const ico=new Image();ico.src='/favicon.ico?v=1';await ico.decode();
                return {images:results,ico:{width:ico.naturalWidth,height:ico.naturalHeight}};
            }''', image_specs)
            for image in checked['images']:
                assert image['width'] == image['height'] == image['size'], image
                assert image['cyan'] and image['violet'], f'Selected fork icon is blank or has lost a colour: {image}'
                if image.get('opaque'):
                    assert image['transparent'] == 0, f'Phone icon has transparent borders: {image}'
                assert image['outside'] == 0, f'Maskable icon can crop the fork: {image}'
            assert checked['ico']['width'] == checked['ico']['height'] and checked['ico']['width'] in [16, 32, 48]
            print(f'PASS {width} favicon, PNG/ICO decoding, phone sizes, mask padding and cache validation', flush=True)
            await page.goto(base+'icon-options.html', wait_until='domcontentloaded')
            await page.evaluate('Promise.all([...document.images].map(image=>image.decode()))')
            await expect(page.get_by_role('button', name='Preview B in this tab', exact=True)).to_have_attribute('aria-pressed', 'true')
            for name, path in [('A','icon-tree.svg'), ('C','icon-monogram.svg'), ('B','icon-fork.svg')]:
                button = page.get_by_role('button', name=f'Preview {name} in this tab', exact=True)
                box = await button.bounding_box()
                assert box and box['width'] >= 44 and box['height'] >= 44
                await button.click()
                await expect(button).to_have_attribute('aria-pressed', 'true')
                await expect(page.locator('#tab-icon')).to_have_attribute('href', '/'+path)
            assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
            assert not errors, errors
            print(f'PASS {width} icon comparison, tab switching and touch targets', flush=True)
            await context.close()
        await browser.close()


asyncio.run(main())
