/* render/cracks.js — P66b: the crack damage field on screen. The sim keeps W.crack (u8 per lattice point, only with the CRACKS lab flag);
 * this module mirrors it into a 3D texture (R8, trilinear) that the terrain and the cut face shaders read (render/terrain.js CRACK_GLSL:
 * dark jagged lines where the damage is high). The texture is re-uploaded when the sim bumps W.crackVer (a blast, a break, a restore).
 * With the flag off (W.crack null) uCrackOn is 0 and the shaders draw nothing. API: dummy(), frame(S). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const CV = SS.crackView = {};
  let tex = null, dummyTex = null, ver = -1, dimKey = '';
  CV.dummy = function () {
    if (!dummyTex) {
      dummyTex = new T.Data3DTexture(new Uint8Array(1), 1, 1, 1);
      dummyTex.format = T.RedFormat; dummyTex.type = T.UnsignedByteType; dummyTex.unpackAlignment = 1;
      dummyTex.minFilter = dummyTex.magFilter = T.LinearFilter; dummyTex.generateMipmaps = false; dummyTex.needsUpdate = true;
    }
    return dummyTex;
  };
  CV.frame = function (S) {
    const U = SS.terrain && SS.terrain.uniforms; if (!U || !U.tCrack) return;
    const W = SS.world, CK = W.crack;
    if (!CK) { if (U.uCrackOn.value) { U.uCrackOn.value = 0; U.tCrack.value = CV.dummy(); ver = -1; } return; }
    const key = W.NX + 'x' + W.NY + 'x' + W.NZ;
    if (!tex || key !== dimKey) {                      // a new map size: a new texture object (three allocates 3D storage once)
      if (tex) tex.dispose();
      tex = new T.Data3DTexture(CK, W.NX, W.NY, W.NZ);
      tex.format = T.RedFormat; tex.type = T.UnsignedByteType; tex.unpackAlignment = 1;
      tex.minFilter = tex.magFilter = T.LinearFilter; tex.wrapS = tex.wrapT = tex.wrapR = T.ClampToEdgeWrapping; tex.generateMipmaps = false;
      dimKey = key; ver = -1;
      U.uCrackSize.value.set(W.NX, W.NY, W.NZ);
    }
    if (tex.image.data !== CK) { tex.image.data = CK; ver = -1; }       // (a new match allocates a new field)
    if (ver !== W.crackVer) { tex.needsUpdate = true; ver = W.crackVer; }
    U.tCrack.value = tex; U.uCrackOn.value = 1;
  };
})(window.SS = window.SS || {});
