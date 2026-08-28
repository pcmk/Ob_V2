const noteArea = document.getElementById("note-area");
const status = document.getElementById("status");
const closeBtn = document.getElementById("close-btn");

let saveTimer = null;

async function init() {
  const { text } = await window.notesAPI.load();
  noteArea.value = text || "";
}

noteArea.addEventListener("input", () => {
  status.textContent = "Saving...";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.notesAPI.save(noteArea.value);
    status.textContent = "Saved";
  }, 500);
});

closeBtn.addEventListener("click", () => window.notesAPI.close());

init();
