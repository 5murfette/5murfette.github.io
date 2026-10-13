/* platform/netsnap.js — P103 binary (de)serializer for the resync snapshot (SS.sim.snapshot: S + the voxel arrays) and
 * the compression
 * around it. Handles what structuredClone handles in S: numbers (f64, Infinity / NaN / -0 exact), strings, booleans,
 * null / undefined, arrays, plain objects, typed arrays, and SHARED references / cycles (S.active is the same object as
 * an entry of S.worms). encode(obj) -> Uint8Array; decode(u8) -> obj; pack(obj) -> Promise<{bytes, raw}> (deflate when
 * CompressionStream exists); unpack(bytes) -> Promise<obj>; b64 / unb64 for the JSON data channel. Pure data: nothing
 * here knows the game. */
(function (SS) {
  'use strict';
  const NS = SS.netsnap = {};
  const KINDS = [Float32Array, Float64Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array, Uint8ClampedArray];
  const TE = new TextEncoder(), TD = new TextDecoder();
  NS.encode = function (root) {
    let buf = new Uint8Array(1 << 20), dv = new DataView(buf.buffer), n = 0;
    const need = k => {
      if (n + k <= buf.length) return;
      let m = buf.length * 2;
      while (m < n + k) m *= 2;
      const nb = new Uint8Array(m);
      nb.set(buf);
      buf = nb;
      dv = new DataView(buf.buffer);
    };
    const u8 = v => {
      need(1);
      buf[n++] = v;
    };
    const u32 = v => {
      need(4);
      dv.setUint32(n, v, true);
      n += 4;
    };
    const seen = new Map(), keys = new Map();
    function str(s) {
      const b = TE.encode(s);
      u32(b.length);
      need(b.length);
      buf.set(b, n);
      n += b.length;
    }
    function key(s) {
      const i = keys.get(s);
      if (i !== undefined) {
        u32(i);
        return;
      }
      u32(keys.size);
      keys.set(s, keys.size);
      str(s);
    }
    function w(v) {
      if (v === undefined) {
        u8(0);
        return;
      }
      if (v === null) {
        u8(1);
        return;
      }
      const t = typeof v;
      if (t === 'boolean') {
        u8(v ? 3 : 2);
        return;
      }
      if (t === 'number') {
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 && !Object.is(v, -0)) {
          u8(5);
          need(4);
          dv.setInt32(n, v, true);
          n += 4;
        }
        else {
          u8(4);
          need(8);
          dv.setFloat64(n, v, true);
          n += 8;
        }
        return;
      }
      if (t === 'string') {
        u8(6);
        str(v);
        return;
      }
      if (t === 'function' || t === 'symbol') {
        u8(0);
        return;
      }
      const id = seen.get(v);
      if (id !== undefined) {
        u8(10);
        u32(id);
        return;
      }
      seen.set(v, seen.size);
      if (ArrayBuffer.isView(v)) {
        const k = KINDS.findIndex(K => v instanceof K);
        if (k < 0) throw new Error('netsnap: unsupported view');
        u8(9);
        u8(k);
        u32(v.length);
        const bl = v.byteLength;
        need(bl);
        buf.set(new Uint8Array(v.buffer, v.byteOffset, bl), n);
        n += bl;
        return;
      }
      if (Array.isArray(v)) {
        u8(7);
        u32(v.length);
        for (let i = 0; i < v.length; i++) w(v[i]);
        return;
      }
      const ks = Object.keys(v);
      u8(8);
      u32(ks.length);
      for (const k of ks) {
        key(k);
        w(v[k]);
      }
    }
    w(root);
    return buf.slice(0, n);
  };
  NS.decode = function (bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let n = 0;
    const objs = [], keys = [];
    const u32 = () => {
      const v = dv.getUint32(n, true);
      n += 4;
      return v;
    };
    const str = () => {
      const l = u32();
      const s = TD.decode(bytes.subarray(n, n + l));
      n += l;
      return s;
    };
    const key = () => {
      const i = u32();
      if (i < keys.length) return keys[i];
      const s = str();
      keys.push(s);
      return s;
    };
    function r() {
      const t = bytes[n++];
      switch (t) {
        case 0: return undefined;
        case 1: return null;
        case 2: return false;
        case 3: return true;
        case 4: {
          const v = dv.getFloat64(n, true);
          n += 8;
          return v;
        }
        case 5: {
          const v = dv.getInt32(n, true);
          n += 4;
          return v;
        }
        case 6: return str();
        case 7: {
          const l = u32(), a = [];
          objs.push(a);
          for (let i = 0; i < l; i++) a.push(r());
          return a;
        }
        case 8: {
          const l = u32(), o = {};
          objs.push(o);
          for (let i = 0; i < l; i++) {
            const k = key();
            o[k] = r();
          }
          return o;
        }
        case 9: {
          const K = KINDS[bytes[n++]], l = u32(), a = new K(l), bl = l * K.BYTES_PER_ELEMENT;
          new Uint8Array(a.buffer).set(bytes.subarray(n, n + bl));
          n += bl;
          objs.push(a);
          return a;
        }
        case 10: return objs[u32()];
        default: throw new Error('netsnap: bad tag ' + t);
      }
    }
    return r();
  };
  async function pipe(u8, S) {
    const rs = new Blob([u8]).stream().pipeThrough(S);
    return new Uint8Array(await new Response(rs).arrayBuffer());
  }
  NS.canZip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof Blob === 'function';
  NS.pack = async function (obj) {
    const raw = NS.encode(obj);
    if (!NS.canZip()) return { bytes: raw, raw: raw.length, z: 0 };
    const z = await pipe(raw, new CompressionStream('deflate'));
    return { bytes: z, raw: raw.length, z: 1 };
  };
  NS.unpack = async function (bytes, z) { return NS.decode(z ? await pipe(bytes, new DecompressionStream('deflate')) : bytes); };
  NS.b64 = u8 => {
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(s);
  };
  NS.unb64 = s => {
    const b = atob(s), u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  };
})(window.SS = window.SS || {});
