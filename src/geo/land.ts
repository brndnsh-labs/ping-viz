// Land lookups from the generated mask (see scripts/land.ts).
import { LAND_H, LAND_RLE, LAND_W } from "./land-data";

let mask: Uint8Array | null = null;

function decode(): Uint8Array {
  const bin = atob(LAND_RLE);
  const out = new Uint8Array(LAND_W * LAND_H);
  let i = 0;
  const next = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = bin.charCodeAt(i++);
      v |= (b & 0x7f) << shift;
      if (b < 0x80) return v;
      shift += 7;
    }
  };
  for (let y = 0; y < LAND_H; y++) {
    let x = 0;
    let land = 0;
    while (x < LAND_W) {
      const run = next();
      if (land) out.fill(1, y * LAND_W + x, y * LAND_W + x + run);
      x += run;
      land ^= 1;
    }
  }
  return out;
}

/** Is this latitude/longitude (degrees) on land? */
export function isLand(lat: number, lon: number): boolean {
  mask ??= decode();
  const x = Math.floor((((((lon + 180) % 360) + 360) % 360) / 360) * LAND_W) % LAND_W;
  const y = Math.min(LAND_H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * LAND_H)));
  return mask[y * LAND_W + x] === 1;
}
