// The packet's real bytes in the text: 16 per row, coloured by layer. Hovering a byte or a field
// highlights the whole field here and (through `data-focus`) in the 3D packet, and shows what it is.
import { AFTER_NAT, type Frame, REPLY, REQUEST } from "../net/packet";

const FRAMES: Record<string, Frame> = { request: REQUEST, nat: AFTER_NAT, reply: REPLY };

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");

export function renderHexdump(el: HTMLElement, which: string): void {
  const frame = FRAMES[which];
  if (!frame) return;
  const only = el.dataset.layers?.split(",") ?? null;
  const fieldOf = new Map<number, (typeof frame.fields)[number]>();
  for (const f of frame.fields) for (let i = 0; i < f.length; i++) fieldOf.set(f.offset + i, f);

  const dump = document.createElement("div");
  dump.className = "hex-bytes";
  for (let row = 0; row < frame.bytes.length; row += 16) {
    const line = document.createElement("div");
    line.className = "hex-row";
    const off = document.createElement("span");
    off.className = "hex-off";
    off.textContent = row.toString(16).padStart(4, "0");
    line.appendChild(off);
    for (let i = row; i < Math.min(row + 16, frame.bytes.length); i++) {
      const f = fieldOf.get(i);
      const b = document.createElement("span");
      b.textContent = hex2(frame.bytes[i] as number);
      b.className = `hb ${f?.layer ?? ""}`;
      if (f) {
        b.dataset.focus = f.id;
        if (only && !only.includes(f.layer)) b.classList.add("dim");
      }
      line.appendChild(b);
    }
    dump.appendChild(line);
  }

  const info = document.createElement("div");
  info.className = "hex-info";
  const idle = "Hover a byte to see which field it belongs to.";
  info.textContent = idle;

  el.replaceChildren(dump, info);
  el.classList.add("hexdump");

  const spans = Array.from(dump.querySelectorAll<HTMLElement>(".hb"));
  let current = "";
  const show = (id: string): void => {
    if (id === current) return;
    current = id;
    for (const s of spans) s.classList.toggle("on", s.dataset.focus === id);
    const f = frame.fields.find((x) => x.id === id);
    if (!f) {
      info.textContent = idle;
      return;
    }
    info.replaceChildren();
    const name = document.createElement("strong");
    name.textContent = `${f.name}: `;
    const val = document.createElement("code");
    val.textContent = f.value;
    const note = document.createElement("span");
    note.textContent = ` ${f.note}`;
    info.append(name, val, note);
  };
  el.addEventListener("pointerover", (e) => {
    const t = (e.target as Element).closest<HTMLElement>("[data-focus]");
    if (t?.dataset.focus) show(t.dataset.focus);
  });
  el.addEventListener("pointerleave", () => show(""));
}
