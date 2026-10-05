# Offline runtime dependencies

The browser engine, post-processing passes, multiplayer client, and fonts are bundled locally so the installed game can start without a network connection.

- `engine.js`: Three.js **0.160.0**, including EffectComposer, RenderPass, UnrealBloomPass, OutputPass, ShaderPass and their dependencies. MIT; see `LICENSE.three.txt`.
- `peerjs.min.js`: PeerJS **1.5.4**, loaded only when opening online play. MIT; see `LICENSE.peerjs.txt`. Signalling/relay services still require internet access.
- `fonts.css`: Bungee and Barlow Semi Condensed, Latin and Latin Extended subsets, from the respective **5.3.0** Fontsource packages. Font data is embedded to support both offline installation and direct-file launch. SIL OFL 1.1; see `LICENSE.bungee.txt` and `LICENSE.barlow-semi-condensed.txt`.

Build with `npm --prefix tools install && npm --prefix tools run build` from the parent `PoC` directory. The build uses esbuild **0.28.2**, retains notices, and generates the content-versioned offline asset list. Package sources are the corresponding public npm packages.
