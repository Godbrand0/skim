/** Accessible token dropdown (button + listbox) used for both the source and destination token. */

export interface SelectOption {
  id: string;
  glyph: string;
  cls: string;
  symbol: string;
  name: string;
  /** Right-aligned detail, such as a balance. */
  detail?: string;
}

export interface SelectHandle {
  setOptions(options: SelectOption[], selectedId: string): void;
}

let uid = 0;

function icon(o: SelectOption): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = `tok ${o.cls}`;
  s.setAttribute("aria-hidden", "true");
  s.textContent = o.glyph;
  return s;
}

export function createSelect(root: HTMLElement, label: string, onChange: (id: string) => void): SelectHandle {
  const listId = `sel-list-${++uid}`;
  let options: SelectOption[] = [];
  let selectedId = "";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sel-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", listId);
  btn.setAttribute("aria-label", label);

  const list = document.createElement("ul");
  list.id = listId;
  list.className = "sel-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", label);
  list.hidden = true;

  root.replaceChildren(btn, list);

  const items = (): HTMLElement[] => Array.from(list.querySelectorAll<HTMLElement>("[role=option]"));

  function close(refocus: boolean): void {
    list.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (refocus) btn.focus();
  }
  function open(): void {
    list.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    const sel = items().find((i) => i.getAttribute("aria-selected") === "true") ?? items()[0];
    sel?.focus();
  }
  function choose(id: string): void {
    close(true);
    if (id !== selectedId) onChange(id);
  }

  btn.addEventListener("click", () => (list.hidden ? open() : close(false)));
  btn.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open();
    }
  });
  list.addEventListener("keydown", (e) => {
    const els = items();
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") (els[Math.min(i + 1, els.length - 1)] ?? els[0])?.focus();
    else if (e.key === "ArrowUp") els[Math.max(i - 1, 0)]?.focus();
    else if (e.key === "Home") els[0]?.focus();
    else if (e.key === "End") els[els.length - 1]?.focus();
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") close(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!list.hidden && !root.contains(e.target as Node)) close(false);
  });

  return {
    setOptions(next, selected) {
      options = next;
      selectedId = selected;
      const cur = options.find((o) => o.id === selected) ?? options[0];

      btn.replaceChildren();
      if (cur) {
        const sym = document.createElement("span");
        sym.className = "sel-sym";
        sym.textContent = cur.symbol;
        const chev = document.createElement("span");
        chev.className = "chev";
        chev.setAttribute("aria-hidden", "true");
        chev.textContent = "▾";
        btn.append(icon(cur), sym, chev);
      }
      btn.disabled = options.length === 0;

      list.replaceChildren();
      for (const o of options) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.tabIndex = -1;
        li.setAttribute("aria-selected", String(o.id === selected));
        const text = document.createElement("span");
        text.className = "opt-text";
        const sym = document.createElement("strong");
        sym.textContent = o.symbol;
        const nm = document.createElement("span");
        nm.className = "muted";
        nm.textContent = o.name;
        text.append(sym, nm);
        li.append(icon(o), text);
        if (o.detail) {
          const d = document.createElement("span");
          d.className = "opt-detail";
          d.textContent = o.detail;
          li.append(d);
        }
        li.addEventListener("click", () => choose(o.id));
        li.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            choose(o.id);
          }
        });
        list.append(li);
      }
    },
  };
}
