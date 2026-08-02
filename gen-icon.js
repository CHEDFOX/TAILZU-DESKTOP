// Generates assets/tray.png (32×32, tray/menu-bar) and assets/icon.png
// (256×256, installer/app icon — electron-builder converts it per-platform) —
// an amber dot in the Tailzu accent #E8A23C, drawn with pure Node (zlib + a
// hand-rolled PNG encoder) so real, valid icons live in the repo without
// shipping binary blobs by hand. Run: npm run icon.
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const R = 0xe8, G = 0xa2, B = 0x3c;

// RGBA scanlines for a SIZE×SIZE anti-aliased disc, each row prefixed with a
// filter byte (0 = none).
function drawDot(SIZE) {
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  let o = 0;
  const c = (SIZE - 1) / 2, rad = SIZE / 2 - 1;
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0;
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - c, y - c);
      let a = 255;
      if (d > rad) a = 0;
      else if (d > rad - 1) a = Math.round(255 * (rad - d)); // 1px anti-alias edge
      raw[o++] = R; raw[o++] = G; raw[o++] = B; raw[o++] = a;
    }
  }
  return raw;
}

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(SIZE) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type 6 = RGBA
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(drawDot(SIZE))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, "assets");
fs.mkdirSync(outDir, { recursive: true });
// icon.png: macOS icns generation REQUIRES ≥512×512 (the mac CI job failed at
// 256 with "must be at least 512x512"); Windows/Linux accept 512 and downscale.
for (const [name, size] of [["tray.png", 32], ["icon.png", 512]]) {
  const png = encodePng(size);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`wrote assets/${name}`, png.length, "bytes");
}
