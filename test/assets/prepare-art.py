"""Prepare GPT Image sources and embed web assets for file:// and HTTP use.

Run with Python + Pillow. Regenerates art-data.js without changing the HTML.
"""
from pathlib import Path
from collections import deque
from io import BytesIO
import base64
import json
from PIL import Image

ROOT = Path(__file__).resolve().parent


def remove_background(image):
    image = image.convert('RGBA')
    w, h = image.size
    pixels = image.load()
    seen = bytearray(w * h)
    queue = deque()
    for x in range(w):
        queue.append((x, 0))
        queue.append((x, h - 1))
    for y in range(h):
        queue.append((0, y))
        queue.append((w - 1, y))
    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        r, g, b, _ = pixels[x, y]
        # Remove only edge-connected navy; preserve enclosed dark outlines.
        if max(r, g, b) > 58 or r > g + 8 or b < r:
            continue
        pixels[x, y] = (r, g, b, 0)
        queue.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    bbox = image.getbbox()
    if bbox:
        image = image.crop(bbox)
    return image


def export(image, name, size):
    image.thumbnail(size, Image.Resampling.LANCZOS)
    output = BytesIO()
    image.save(output, format='WEBP', quality=90, method=6)
    data = output.getvalue()
    (ROOT / name).write_bytes(data)
    return 'data:image/webp;base64,' + base64.b64encode(data).decode('ascii')


logo = remove_background(Image.open(ROOT / 'logo-source.png'))
assets = {'logo': export(logo, 'logo.webp', (640, 560))}
assets['terrain'] = export(Image.open(ROOT / 'terrain-atlas.png'), 'terrain-atlas.webp', (1024, 1024))
assets['icons'] = {}
sheets = {
    'tool-icons-source.png': ('bellows', 'sniper', 'foam', 'magnet', 'spring', 'grenade'),
    'arsenal-a-source.png': ('bazooka', 'cluster', 'shotgun', 'bat', 'homing', 'dynamite'),
    'arsenal-b-source.png': ('banana', 'airstrike', 'holy', 'sheep', 'boulder', 'blackhole'),
    'arsenal-c-source.png': ('tesla', 'napalm', 'moai', 'mine', 'drill', 'rope'),
    'arsenal-d-source.png': ('teleport', 'girder', 'scrambler', 'skip', 'magnet', 'spring'),
    'weapon-revisions-source.png': ('tesla', 'sniper', None, None, None, None),
}
for filename, names in sheets.items():
    sheet = Image.open(ROOT / filename)
    cw, ch = sheet.width // 3, sheet.height // 2
    for i, name in enumerate(names):
        if name is None:
            continue
        x, y = i % 3 * cw, i // 3 * ch
        icon = remove_background(sheet.crop((x, y, x + cw, y + ch)))
        assets['icons'][name] = export(icon, f'icon-{name}.webp', (128, 128))
sheet = Image.open(ROOT / 'torch-breaker-source.png')
for i, name in enumerate(('drill', 'breaker')):
    icon = remove_background(sheet.crop((i * sheet.width // 2, 0, (i + 1) * sheet.width // 2, sheet.height)))
    assets['icons'][name] = export(icon, f'icon-{name}.webp', (128, 128))
(ROOT / 'art-data.js').write_text('/* Prepared GPT Image artwork; see README.md. */\nwindow.BB_ART = ' + json.dumps(assets, separators=(',', ':')) + ';\n')
print(f"Prepared logo, terrain atlas, {len(assets['icons'])} icons and embedded asset bundle.")
