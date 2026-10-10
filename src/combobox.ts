// A single-input model picker: shows the selected item; typing filters the
// list below as you type (every word must match), arrows move, Enter or a
// click picks, Escape or leaving the field restores the selection.

export interface ComboItem {
  id: string;
  label: string;
  detail?: string;
}

export interface Combobox {
  el: HTMLElement;
  setItems(items: ComboItem[], selectedId: string): void;
  get value(): string;
}

export function combobox(opts: { id: string; ariaLabel: string; onPick: (id: string) => void }): Combobox {
  let items: ComboItem[] = [];
  let selected = "";
  let shown: ComboItem[] = [];
  let active = -1;
  /** False right after opening: the field shows the selection, the list shows everything. */
  let filtering = false;

  const input = document.createElement("input");
  input.id = opts.id;
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", opts.ariaLabel);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const list = document.createElement("ul");
  list.id = `${opts.id}-list`;
  list.className = "combo-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  input.setAttribute("aria-controls", list.id);
  const el = document.createElement("div");
  el.className = "combo";
  el.append(input, list);

  const labelOf = (id: string) => items.find((i) => i.id === id)?.label ?? id;
  const showSelected = () => {
    input.value = labelOf(selected);
  };

  function render(): void {
    const terms = filtering ? input.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
    shown = items.filter((i) => {
      const hay = `${i.label} ${i.id}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    if (active >= shown.length) active = shown.length - 1;
    list.replaceChildren(
      ...(shown.length
        ? shown.map((i, n) => {
            const li = document.createElement("li");
            li.id = `${opts.id}-opt-${n}`;
            li.setAttribute("role", "option");
            li.setAttribute("aria-selected", String(n === active));
            if (i.id === selected) li.classList.add("current");
            if (n === active) li.classList.add("active");
            const name = document.createElement("span");
            name.textContent = i.label;
            li.append(name);
            if (i.detail) {
              const d = document.createElement("span");
              d.className = "detail";
              d.textContent = i.detail;
              li.append(d);
            }
            // mousedown, not click: it fires before the input's blur
            li.addEventListener("mousedown", (e) => {
              e.preventDefault();
              pick(i.id);
            });
            return li;
          })
        : [Object.assign(document.createElement("li"), { className: "empty", textContent: "No matching model" })]),
    );
    if (active >= 0) input.setAttribute("aria-activedescendant", `${opts.id}-opt-${active}`);
    else input.removeAttribute("aria-activedescendant");
    list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }

  function open(filter: boolean): void {
    filtering = filter;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (!filter) {
      // Opening shows the whole list with the current model highlighted.
      render();
      active = shown.findIndex((i) => i.id === selected);
    }
    render();
  }

  function close(): void {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
    filtering = false;
    showSelected();
  }

  function pick(id: string): void {
    const changed = id !== selected;
    selected = id;
    close();
    input.blur();
    if (changed) opts.onPick(id);
  }

  input.addEventListener("focus", () => {
    open(false);
    input.select();
  });
  input.addEventListener("input", () => {
    active = 0;
    open(true);
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (list.hidden) open(false);
      const n = shown.length;
      if (!n) return;
      active = e.key === "ArrowDown" ? (active + 1) % n : (active - 1 + n) % n;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const i = shown[active >= 0 ? active : 0];
      if (i && !list.hidden) pick(i.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      input.blur();
    }
  });

  return {
    el,
    setItems(next: ComboItem[], selectedId: string) {
      items = next;
      selected = selectedId;
      if (list.hidden) showSelected();
      else render();
    },
    get value() {
      return selected;
    },
  };
}
