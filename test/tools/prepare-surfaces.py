"""Prepare original GPT Image 2.5 liquid materials and industrial tool icons."""
from pathlib import Path
from io import BytesIO
import base64
import json
from PIL import Image

root = Path(__file__).resolve().parent.parent / 'assets'
sheet = Image.open(root / 'liquid-surfaces-source.png').convert('RGB')
assets = {}
for i, name in enumerate(('water', 'lava', 'cooledLava', 'tuff')):
    x, y = i % 2 * sheet.width // 2, i // 2 * sheet.height // 2
    tile = sheet.crop((x, y, x + sheet.width // 2, y + sheet.height // 2)).resize((256, 256), Image.Resampling.LANCZOS)
    out = BytesIO(); tile.save(out, 'WEBP', quality=88)
    (root / (name + '-surface.webp')).write_bytes(out.getvalue())
    assets[name] = 'data:image/webp;base64,' + base64.b64encode(out.getvalue()).decode()
(root / 'surface-data.js').write_text('/* Original GPT Image 2.5 materials; embedded for direct-file/offline use. */\nwindow.BB_SURFACES = ' + json.dumps(assets, separators=(',', ':')) + ';\n')
