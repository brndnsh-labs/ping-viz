// The heads-up display: the real-time clock, where we are, and the chapter rail.
import { type Act, CHAPTERS, type ChapterDef } from "../story/chapters";
import { clockAt, formatClock } from "../story/clock";

const ACT_NAME: Record<Act, string> = {
  intro: "",
  ping: "Act I · ping google.com",
  claude: "Act II · claude",
  outro: "",
};

export class Hud {
  private readonly act: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly clockValue: HTMLElement;
  private readonly since: HTMLElement;
  private readonly where: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly links: HTMLAnchorElement[] = [];
  private last = { act: "", clock: "", where: "", index: -1, since: "", visible: false };

  constructor(root: HTMLElement, rail: HTMLElement, onJump: (index: number) => void) {
    this.act = root.querySelector("#hud-act") as HTMLElement;
    this.clock = root.querySelector("#hud-clock") as HTMLElement;
    this.clockValue = root.querySelector("#hud-clock-v") as HTMLElement;
    this.since = root.querySelector("#hud-since") as HTMLElement;
    this.where = root.querySelector("#hud-where") as HTMLElement;
    this.progress = root.querySelector("#hud-progress") as HTMLElement;

    const list = document.createElement("ol");
    let lastAct: Act | null = null;
    for (const [i, c] of CHAPTERS.entries()) {
      const li = document.createElement("li");
      if (c.act !== lastAct) li.classList.add("act-start");
      lastAct = c.act;
      li.dataset.act = c.act;
      const a = document.createElement("a");
      a.href = `#${c.id}`;
      a.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="name">${c.title}</span>`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        onJump(i);
      });
      li.appendChild(a);
      list.appendChild(li);
      this.links.push(a);
    }
    rail.appendChild(list);
  }

  update(index: number, p: number, chapter: ChapterDef): void {
    this.progress.style.transform = `scaleX(${((index + p) / CHAPTERS.length).toFixed(4)})`;
    const act = ACT_NAME[chapter.act];
    if (act !== this.last.act) {
      this.act.textContent = act;
      this.last.act = act;
    }
    const visible = chapter.clock !== null;
    if (visible !== this.last.visible) {
      this.clock.classList.toggle("off", !visible);
      this.last.visible = visible;
    }
    if (chapter.clock) {
      const v = formatClock(clockAt(chapter.clock, p, chapter.clockEase), chapter.act);
      if (v !== this.last.clock) {
        this.clockValue.textContent = v;
        this.last.clock = v;
      }
      const since = chapter.act === "ping" ? "since you pressed Enter" : "since you sent the prompt";
      if (since !== this.last.since) {
        this.since.textContent = since;
        this.last.since = since;
      }
    }
    if (chapter.where !== this.last.where) {
      this.where.textContent = chapter.where;
      this.last.where = chapter.where;
    }
    if (index !== this.last.index) {
      this.links[this.last.index]?.removeAttribute("aria-current");
      this.links[index]?.setAttribute("aria-current", "step");
      this.last.index = index;
    }
  }
}
