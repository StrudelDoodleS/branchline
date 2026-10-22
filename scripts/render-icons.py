# Branchline fork modifications; see FORK.md.
"""Export the SVG to browser/phone PNGs and an ICO.

uvx --from playwright python scripts/render-icons.py
Use PLAYWRIGHT_CHROMIUM_EXECUTABLE for an existing Chromium installation.
"""
import asyncio
import os
import struct
from pathlib import Path
from playwright.async_api import async_playwright

PUBLIC = Path(__file__).resolve().parents[1] / 'web' / 'public'


async def main():
    svg = (PUBLIC / 'icon.svg').read_text()
    async with async_playwright() as p:
        launch = dict(headless=True, args=['--no-sandbox'])
        if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'):
            launch['executable_path'] = os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        browser = await p.chromium.launch(**launch)
        page = await browser.new_page(device_scale_factor=1)

        async def render(size, opaque=False, maskable=False):
            await page.set_viewport_size(dict(width=size, height=size))
            mark = svg
            if maskable:
                start = mark.index('>', mark.index('<svg')) + 1
                mark = mark[:start] + '<g transform="translate(6.4 6.4) scale(.8)">' + mark[start:]
                mark = mark.replace('</svg>', '</g></svg>')
            background = '#0f172a' if opaque else 'transparent'
            await page.set_content(f'<style>html,body{{margin:0;width:100%;height:100%;background:{background};overflow:hidden}}svg{{display:block;width:100%;height:100%}}</style>{mark}')
            return await page.screenshot(omit_background=not opaque)

        ico_sizes = [16, 32, 48]
        ico_pngs = [await render(size) for size in ico_sizes]
        (PUBLIC / 'icon-32.png').write_bytes(ico_pngs[1])
        for size in [180, 192, 512]:
            name = 'apple-touch-icon.png' if size == 180 else f'icon-{size}.png'
            (PUBLIC / name).write_bytes(await render(size, opaque=True))
        (PUBLIC / 'icon-maskable-512.png').write_bytes(await render(512, opaque=True, maskable=True))
        offset = 6 + 16 * len(ico_sizes)
        entries = []
        for size, png in zip(ico_sizes, ico_pngs):
            entries.append(struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(png), offset))
            offset += len(png)
        (PUBLIC / 'favicon.ico').write_bytes(struct.pack('<HHH', 0, 1, len(entries)) + b''.join(entries) + b''.join(ico_pngs))
        await browser.close()
    print('Exported 16/32/48 px favicon, 180 px Apple icon, and 192/512 px phone icons.')


asyncio.run(main())
