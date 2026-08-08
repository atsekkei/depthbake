export function bindButtonGroup(ids: string[], onSelect: (index: number) => void): void {
  const els = ids.map((id) => document.getElementById(id) as HTMLButtonElement);
  const setActive = (index: number) => {
    els.forEach((e, j) => {
      const active = j === index;
      e.classList.toggle("is-active", active);
      e.setAttribute("aria-pressed", String(active));
    });
  };
  setActive(els.findIndex((el) => el.classList.contains("is-active")));
  els.forEach((el, i) => {
    el.onclick = () => {
      onSelect(i);
      setActive(i);
    };
  });
}

export function bindSlider(
  id: string,
  outId: string,
  onInput: (value: number) => void,
  fmt: (value: number) => string,
): void {
  const el = document.getElementById(id) as HTMLInputElement;
  const out = document.getElementById(outId)!;
  el.oninput = () => {
    const v = parseFloat(el.value);
    onInput(v);
    out.textContent = fmt(v);
  };
}
