# GPT Image artwork experiment

Generated for Burrow Brawl using Azure Foundry `gpt-image-2.5-flare` on 5 October 2026.

## Integrated assets

- `logo.webp`: pink segmented worm with workshop goggles, earth lettering and spring gadget. Displayed in setup.
- `terrain-atlas.webp`: a 2×2 atlas: soil and rock on the top row, sand and ice on the bottom row. Blended onto the destructible terrain front face at a 128-world-unit texture scale. Mirrored sampling softens tile seams; atlas insets reduce quadrant bleed.
- `icon-*.webp`: 28 transparent inventory icons covering every current weapon/tool, including Pocket Magnet, Spring Mine and Fuse Scrambler. The touch weapon button uses the same artwork.
- `art-data.js`: embedded WebP data URLs, allowing texture loading when opening the HTML directly through `file://` as well as through HTTP. Keep the `assets` folder beside the HTML.

Original PNG generations are retained as `logo-source.png`, `terrain-atlas.png` and `tool-icons-source.png`.
Four additional six-cell generations (`arsenal-a-source.png` through `arsenal-d-source.png`) cover the remaining arsenal. Rows map to weapon IDs in `prepare-art.py`; the build reports 28 distinct icons.
`weapon-revisions-source.png` overrides Thunder Strike with a lightning bolt and the former Snipper slot with a scoped Sniper Rifle. Internal IDs `tesla` and `snipper` remain stable for inventory/network compatibility.

## Art direction and source briefs

Original, playful hand-painted workshop/diorama style: cream and amber title lettering, pink worm, blue/brass gadgets, readable shapes and restrained material detail.

- Logo: exact stacked text **BURROW BRAWL**, pink smooth segmented worm wearing brass goggles, broken earth, flying pebbles and blue spring, dark navy background. An initial furry mascot result was replaced by a fresh worm-specific generation.
- Materials: exact four equal square quadrants, orthographic diffuse material views, soil with pebbles/roots, fractured slate, rippled ochre sand and blue ice with bubbles; no scenery, text or borders.
- Icon sheet: exact three columns/two rows, isolated bellows, cutting device, foam launcher, magnet, spring mine and grenade, dark navy background, independent padded silhouettes.

Image-edit calls to the available Azure deployments returned HTTP 404; the final logo was generated afresh. Sources were visually inspected. Seamlessness is handled conservatively in the shader rather than assumed from the generation prompt.

## Preparing assets

Install Pillow in a Python environment and run:

```sh
python assets/prepare-art.py
```

This crops all five icon sheets, removes edge-connected navy backgrounds, resizes/compresses WebP outputs and recreates `art-data.js`. It does not alter the HTML.

## Presentation rules

- The Artwork setting and pause-menu Art button switch between painted and procedural presentation without changing collision geometry or game state.
- Terrain material IDs select atlas quadrants; texture updates follow terrain edits.
- Green surface skin, structures, foam and strongly red blood staining retain their procedural colors.
- Terrain walls and physical rubble retain existing procedural rendering.
- Missing artwork falls back to the procedural renderer and SVG icons.

## Verification

Chromium checks cover logo/icon loading, WebGL shader compilation, match startup, weapon controls, artwork switching without material-mask changes, and the preceding physics-tool behavior checks. Artwork is an experimental visual direction, not final production art.
