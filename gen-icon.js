// One-off helper: generate a simple sticky-note tray icon (32x32 PNG).
const zlib = require('zlib');
const fs = require('fs');

const W = 32, H = 32;
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  const row = y * (W * 4 + 1);
  raw[row] = 0;
  for (let x = 0; x < W; x++) {
    const i = row + 1 + x * 4;
    let inside = x >= 4 && x <= 27 && y >= 3 && y <= 28;
    // rounded corners
    if (inside) {
      const corners = [[4, 3], [27, 3], [4, 28], [27, 28]];
      for (const [cx, cy] of corners) {
        if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2 && Math.hypot(x - cx, y - cy) > 2.6) inside = false;
      }
    }
    if (inside) {
      raw[i] = 255; raw[i + 1] = 214; raw[i + 2] = 90; raw[i + 3] = 255;
      if ((y === 13 || y === 18 || y === 23) && x >= 8 && x <= 22) {
        raw[i] = 140; raw[i + 1] = 112; raw[i + 2] = 50;
      }
    } else {
      raw[i] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0;
    }
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(process.argv[2], png);
console.log('icon written to', process.argv[2]);
