export function bindDropzone(dropEl: HTMLElement, fileInput: HTMLInputElement, onFile: (file: File) => void): void {
  dropEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    fileInput.click();
  });
  ["dragover", "dragenter"].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => {
      e.preventDefault();
      dropEl.classList.add("is-dragging");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => {
      e.preventDefault();
      dropEl.classList.remove("is-dragging");
    }),
  );
  dropEl.addEventListener("drop", (e) => {
    const file = (e as DragEvent).dataTransfer?.files[0];
    if (file) onFile(file);
  });
  fileInput.onchange = () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) onFile(file);
  };
}
