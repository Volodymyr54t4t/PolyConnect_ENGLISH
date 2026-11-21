const achievementEls = {
  form: document.querySelector("#achievementForm"),
  photo: document.querySelector("#achievementPhoto"),
  alert: document.querySelector("#achievementAlert"),
  progress: document.querySelector("#achievementProgress"),
  list: document.querySelector("#myAchievements"),
  dialog: document.querySelector("#achievementDialog"),
  openButton: document.querySelector("#openAchievementBtn"),
}

function escapeAchievement(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char])
}

function showAchievementAlert(message, ok = false) {
  if (window.modalAlert) return modalAlert(message)
  achievementEls.alert.textContent = message
  achievementEls.alert.style.color = ok ? "var(--ok)" : "var(--danger)"
}

function setAchievementProgress(message = "") {
  achievementEls.progress.textContent = message
}

function toggleAchievementDialog(isOpen) {
  achievementEls.dialog.classList.toggle("hidden", !isOpen)
  document.body.classList.toggle("modal-open", isOpen)
  if (isOpen) achievementEls.form.elements.title.focus()
}

function startAchievementTimer() {
  const startedAt = Date.now()
  setAchievementProgress("Processing… 0 seconds elapsed")
  const timer = window.setInterval(() => {
    setAchievementProgress(`Processing… elapsed ${Math.floor((Date.now() - startedAt) / 1000)} sec`)
  }, 250)
  return () => {
    window.clearInterval(timer)
    return ((Date.now() - startedAt) / 1000).toFixed(1)
  }
}

function renderMyAchievements(items) {
  if (!items.length) {
    achievementEls.list.innerHTML = '<p class="form-alert">You have not added any achievements yet.</p>'
    return
  }
  achievementEls.list.innerHTML = items.map((item) => `
    <article class="my-achievement">
      ${item.photo ? `<img src="${item.photo}" alt="" />` : '<span class="my-achievement__placeholder" aria-hidden="true"></span>'}
      <div><span class="achievement-type-pill">${escapeAchievement(item.achievement_type || "Achievement")}</span><h3>${escapeAchievement(item.title)}</h3><div class="my-achievement__details">${item.event_name ? `<span>${escapeAchievement(item.event_name)}</span>` : ""}${item.achievement_date ? `<span>${escapeAchievement(new Intl.DateTimeFormat("en-US").format(new Date(item.achievement_date)))}</span>` : ""}${item.result ? `<b>${escapeAchievement(item.result)}</b>` : ""}${item.link ? `<a href="${escapeAchievement(item.link)}" target="_blank" rel="noopener noreferrer">Proof ↗</a>` : ""}</div><p>${escapeAchievement(item.description) || "No details provided"}</p><small>${item.is_public ? "Public" : "Private"}</small></div>
      <button class="achievement-delete" type="button" data-achievement-id="${item.id}">Delete</button>
    </article>`).join("")
}

async function loadMyAchievements() {
  const response = await fetch("/api/achievements/mine")
  if (!response.ok) throw new Error("Could not load achievements")
  const data = await response.json()
  renderMyAchievements(data.achievements || [])
}

const sheetImportForm = document.querySelector("#googleSheetImportForm")
if (sheetImportForm) {
  const sheetUrl = document.querySelector("#googleSheetUrl")
  const sheetMessage = document.querySelector("#googleSheetImportMessage")
  const sheetPreview = document.querySelector("#googleSheetPreview")
  const sheetRowsHost = document.querySelector("#googleSheetPreviewRows")
  const sheetSummary = document.querySelector("#googleSheetPreviewSummary")
  const sheetSelectAll = document.querySelector("#googleSheetSelectAll")
  const sheetImportButton = document.querySelector("#googleSheetImportButton")
  let previewRows = []
  const sheetMessageShow = (message, error = false) => { sheetMessage.textContent = message; sheetMessage.style.color = error ? "var(--danger)" : "var(--primary)" }
  const readSheetResponse = async response => {
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.includes("application/json")) {
      if (response.status === 404) throw new Error("The server does not support the latest Google Sheets import yet (HTTP 404). Restart or update the portal server.")
      if (response.redirected || contentType.includes("text/html")) throw new Error("The server returned a page instead of an API response. Refresh and sign in again.")
      throw new Error(`The server returned an unexpected response (HTTP ${response.status}). Please try again or contact an administrator.`)
    }
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `Server error (HTTP ${response.status})`)
    return data
  }
  const selectedSheetRows = () => [...sheetRowsHost.querySelectorAll("[data-sheet-row]:checked")].map(input => previewRows[Number(input.dataset.sheetRow)])
  const updateSheetSelection = () => {
    const selected = selectedSheetRows().length
    sheetImportButton.textContent = `Import selected (${selected})`
    const valid = previewRows.filter(row => !row.error).length
    sheetSelectAll.checked = selected > 0 && selected === valid
    sheetSelectAll.indeterminate = selected > 0 && selected < valid
  }
  sheetImportForm.addEventListener("submit", async event => {
    event.preventDefault()
    const submit = document.querySelector("#googleSheetPreviewButton")
    submit.disabled = true; submit.textContent = "Reading spreadsheet…"; sheetPreview.classList.add("hidden"); sheetMessageShow("")
    try {
      const response = await fetch("/api/achievements/google-sheet/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: sheetUrl.value.trim() }) })
      const data = await readSheetResponse(response)
      if (!Array.isArray(data.rows)) throw new Error("The server did not return any spreadsheet rows. Refresh and try again.")
      previewRows = data.rows || []
      const valid = previewRows.filter(row => !row.error).length
      sheetSummary.textContent = `${valid} valid out of ${previewRows.length} rows${data.truncated ? ` · showing the first ${previewRows.length} of ${data.totalRows}` : ""}`
      sheetRowsHost.innerHTML = previewRows.map((row, index) => `<tr class="${row.error ? "is-error" : ""}"><td><input type="checkbox" data-sheet-row="${index}" ${row.error ? "disabled" : "checked"} aria-label="Select row ${row.row_number}"></td><td>${escapeAchievement(row.title || "—")}</td><td>${escapeAchievement(row.achievement_type || "Achievement")}</td><td>${escapeAchievement(row.event_name || "—")}</td><td>${escapeAchievement(row.achievement_date || "—")}</td><td>${escapeAchievement(row.result || "—")}</td><td>${escapeAchievement(row.error || "Ready")}</td></tr>`).join("")
      sheetPreview.classList.remove("hidden"); updateSheetSelection()
      sheetMessageShow("Review the entries and uncheck any you do not want to add.")
    } catch (error) { sheetMessageShow(error.message, true) }
    finally { submit.disabled = false; submit.textContent = "Preview records" }
  })
  sheetRowsHost.addEventListener("change", updateSheetSelection)
  sheetSelectAll.addEventListener("change", () => { sheetRowsHost.querySelectorAll("[data-sheet-row]:not(:disabled)").forEach(input => { input.checked = sheetSelectAll.checked }); updateSheetSelection() })
  sheetImportButton.addEventListener("click", async () => {
    const selected = selectedSheetRows()
    if (!selected.length) { sheetMessageShow("Select at least one valid row.", true); return }
    sheetImportButton.disabled = true; sheetImportButton.textContent = "Importing…"
    try {
      const response = await fetch("/api/achievements/google-sheet/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: selected }) })
      const data = await readSheetResponse(response)
      sheetMessageShow(data.message || "Import complete.")
      sheetPreview.classList.add("hidden"); previewRows = []
      await loadMyAchievements()
    } catch (error) { sheetMessageShow(error.message, true) }
    finally { sheetImportButton.disabled = false }
  })
}

function readAchievementPhoto() {
  const file = achievementEls.photo.files[0]
  if (!file) return Promise.resolve("")
  if (file.size > 4 * 1024 * 1024) return Promise.reject(new Error("Achievement photo cannot exceed 4 MB"))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error("Could not read the photo"))
    reader.readAsDataURL(file)
  })
}

achievementEls.form.addEventListener("submit", async (event) => {
  event.preventDefault()
  const submitButton = achievementEls.form.querySelector("button[type=submit]")
  submitButton.disabled = true
  const finishTimer = startAchievementTimer()
  try {
    const formData = new FormData(achievementEls.form)
    const response = await fetch("/api/achievements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: formData.get("title"),
        achievement_type: formData.get("achievement_type"),
        event_name: formData.get("event_name"),
        organizer: formData.get("organizer"),
        location: formData.get("location"),
        achievement_date: formData.get("achievement_date"),
        result: formData.get("result"),
        link: formData.get("link"),
        description: formData.get("description"),
        photo: await readAchievementPhoto(),
        is_public: formData.get("is_public") === "on",
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || "Could not save the achievement")
    achievementEls.form.reset()
    const elapsed = finishTimer()
    showAchievementAlert("Achievement added", true)
    setAchievementProgress(`Done in ${elapsed} sec. You can close this window.`)
    await loadMyAchievements()
  } catch (error) {
    const elapsed = finishTimer()
    showAchievementAlert(error.message)
    setAchievementProgress(`Could not save in ${elapsed} sec. Check the details and try again.`)
  } finally {
    submitButton.disabled = false
  }
})

achievementEls.list.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-achievement-id]")
  if (!button) return
  const response = await fetch(`/api/achievements/${button.dataset.achievementId}`, { method: "DELETE" })
  if (!response.ok) return showAchievementAlert("Could not delete the achievement")
  await loadMyAchievements()
})

achievementEls.openButton.addEventListener("click", () => toggleAchievementDialog(true))
document.querySelectorAll("[data-close-achievement]").forEach((element) => element.addEventListener("click", () => toggleAchievementDialog(false)))
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleAchievementDialog(false)
})

loadMyAchievements().catch((error) => showAchievementAlert(error.message))
