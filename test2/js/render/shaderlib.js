/* render/shaderlib.js — the GLSL chunks the game's shaders share: the hashes and the value noises. Each chunk is one
 * future .hlsl include: its functions carry the sl_ prefix and an #ifndef guard (a shader that takes two chunks needing
 * the same hash gets it once), and a chunk includes the chunks it uses. The expressions are the ones the shaders had,
 * token for token: the pictures do not change.
 *   HASH12S   sl_hash12s(vec2): the sine hash, fract(sin(dot(p, (127.1, 311.7))) * 43758.5453)
 *   HASH13    sl_hash13(vec3): Dave Hoskins' sine-free hash of a 3D point
 *   VNOISE2S  sl_vnoise2s(vec2): smooth value noise on HASH12S (a cubic Hermite blend of the 4 cell corners)
 *   VNOISE3   sl_vnoise3(vec3): smooth value noise on HASH13 (8 corners)
 *   FBM2S     sl_fbm2s(vec2): 4 octaves of VNOISE2S (x 2.03 + (1.7, -0.6) per octave)
 *   ONE_SIDED_NORMAL  the normal chunk of a built-in material without the back-face flip (for #include
 *             <normal_fragment_begin>): a double-sided material whose back faces keep the front normal
 * C / HLSL: a .hlsl include per chunk with the same names. */
(function (SS) {
  'use strict';
  const SL = SS.glsl = {};
  const chunk = (name, src) => `#ifndef SL_${name}\n#define SL_${name}\n${src}\n#endif\n`;
  SL.HASH12S = chunk('HASH12S', 'float sl_hash12s(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }');
  SL.HASH13 = chunk('HASH13', /* glsl */ `float sl_hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}`);
  SL.VNOISE2S = SL.HASH12S + chunk('VNOISE2S', /* glsl */ `float sl_vnoise2s(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sl_hash12s(i), sl_hash12s(i + vec2(1, 0)), f.x),
             mix(sl_hash12s(i + vec2(0, 1)), sl_hash12s(i + vec2(1, 1)), f.x), f.y);
}`);
  SL.VNOISE3 = SL.HASH13 + chunk('VNOISE3', /* glsl */ `float sl_vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sl_hash13(i), sl_hash13(i + vec3(1, 0, 0)), f.x),
                 mix(sl_hash13(i + vec3(0, 1, 0)), sl_hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(sl_hash13(i + vec3(0, 0, 1)), sl_hash13(i + vec3(1, 0, 1)), f.x),
                 mix(sl_hash13(i + vec3(0, 1, 1)), sl_hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`);
  SL.FBM2S = SL.VNOISE2S + chunk('FBM2S', /* glsl */ `float sl_fbm2s(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * sl_vnoise2s(p);
    p = p * 2.03 + vec2(1.7, -0.6);
    a *= 0.5;
  }
  return s;
}`);
  SL.ONE_SIDED_NORMAL = THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0');
})(window.SS = window.SS || {});
