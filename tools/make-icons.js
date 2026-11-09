// Génère les icônes PNG de l'app (sans dépendance) : node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function roundRect(x, y, x0, y0, w, h, r) {
  const cx = Math.min(Math.max(x, x0 + r), x0 + w - r), cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
  return Math.hypot(x - cx, y - cy) <= r && x >= x0 && x <= x0 + w && y >= y0 && y <= y0 + h;
}
function draw(size, { bg, pad }) {
  const S = 4; // suréchantillonnage pour l'anticrénelage
  const px = Buffer.alloc(size * size * 4);
  const BG = hex('#1db954'), BODY = hex('#2b2c30'), BEZ = hex('#0d0d0f'), SCR = hex('#e8eef5'), HL = hex('#2f7de1'), WH = hex('#45464c'), CEN = hex('#2b2c30');
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const u = (x + (sx + 0.5) / S) / size, v = (y + (sy + 0.5) / S) / size;
      let col = null;
      if (bg) col = BG;
      // corps de l'iPod (proportions 1 : 1,66)
      const bh = 1 - 2 * pad, bw = bh / 1.66, bx = 0.5 - bw / 2, by = pad;
      if (roundRect(u, v, bx, by, bw, bh, bw * 0.12)) {
        col = BODY;
        const sx0 = bx + bw * 0.08, sy0 = by + bw * 0.08, sw = bw * 0.84, sh = bw * 0.66;
        if (roundRect(u, v, sx0, sy0, sw, sh, bw * 0.04)) {
          col = BEZ;
          const ix = sx0 + bw * 0.035, iy = sy0 + bw * 0.035, iw = sw - bw * 0.07, ih = sh - bw * 0.07;
          if (u >= ix && u <= ix + iw && v >= iy && v <= iy + ih) {
            col = SCR;
            const row = (v - iy) / ih;
            if (row > 0.18 && row < 0.36) col = HL;
          }
        }
        const wcx = 0.5, wcy = by + bh * 0.70, wr = bw * 0.36, cr = bw * 0.13;
        const d = Math.hypot(u - wcx, v - wcy);
        if (d <= wr) col = d <= cr ? CEN : WH;
      }
      if (col) { acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255; }
    }
    const n = S * S, i = (y * size + x) * 4, a = acc[3] / n;
    px[i] = a ? acc[0] / (acc[3] / 255) : 0; px[i + 1] = a ? acc[1] / (acc[3] / 255) : 0; px[i + 2] = a ? acc[2] / (acc[3] / 255) : 0; px[i + 3] = a;
  }
  return png(size, px);
}
const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), draw(192, { bg: true, pad: 0.12 }));
fs.writeFileSync(path.join(out, 'icon-512.png'), draw(512, { bg: true, pad: 0.12 }));
fs.writeFileSync(path.join(out, 'icon-512-maskable.png'), draw(512, { bg: true, pad: 0.2 }));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), draw(180, { bg: true, pad: 0.12 }));
console.log('Icônes générées dans', out);
