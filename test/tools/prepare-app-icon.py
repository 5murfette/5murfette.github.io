"""Prepare runtime launcher images from the original GPT Image artwork (requires Pillow)."""
from pathlib import Path
from math import hypot
from PIL import Image, ImageFilter

root = Path(__file__).resolve().parent.parent / "assets" / "app"
source = Image.open(root / "icon-source.png").convert("RGB")
for filename, size in [("icon-192.png", 192), ("icon-512.png", 512),
                       ("apple-touch-icon.png", 180), ("favicon-32.png", 32)]:
    source.resize((size, size), Image.Resampling.LANCZOS).save(root / filename, optimize=True)
# Keep the complete foreground within the launcher's central 80%-diameter safe circle.
# The outer background supplies bleed for circles, squircles and adaptive Android masks.
maskable = source.resize((512, 512), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(85))
wash = Image.new("RGB", (512, 512), "#05223d")
maskable = Image.blend(maskable, wash, .75)
small = source.resize((400, 400), Image.Resampling.LANCZOS)
edge = Image.new("L", small.size, 0)
edge.putdata([int(255 * min(1, max(0, (220 - hypot(x - 199.5, y - 199.5)) / 55)) *
                  min(1, min(x, y, 399 - x, 399 - y) / 20)) for y in range(400) for x in range(400)])
maskable.paste(small, (56, 56), edge)
maskable.save(root / "icon-maskable-512.png", optimize=True)
print("Prepared 192px, 512px, maskable, Apple touch and favicon images.")
