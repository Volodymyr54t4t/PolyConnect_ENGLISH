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
  setAchievementProgress("Обробка… минуло 0 с")
  const timer = window.setInterval(() => {
    setAchievementProgress(`Обробка… минуло ${Math.floor((Date.now() - startedAt) / 1000)} с`)
  }, 250)
  return () => {
    window.clearInterval(timer)
    return ((Date.now() - startedAt) / 1000).toFixed(1)
  }
}

function renderMyAchievements(items) {
  if (!items.length) {
    achievementEls.list.innerHTML = '<p class="form-alert">У вас ще немає доданих досягнень.</p>'
    return
  }
  achievementEls.list.innerHTML = items.map((item) => `
    <article class="my-achievement">
      ${item.photo ? `<img src="${item.photo}" alt="" />` : '<span class="my-achievement__placeholder" aria-hidden="true"></span>'}
      <div><span class="achievement-type-pill">${escapeAchievement(item.achievement_type || "Досягнення")}</span><h3>${escapeAchievement(item.title)}</h3><div class="my-achievement__details">${item.event_name ? `<span>${escapeAchievement(item.event_name)}</span>` : ""}${item.achievement_date ? `<span>${escapeAchievement(new Intl.DateTimeFormat("uk-UA").format(new Date(item.achievement_date)))}</span>` : ""}${item.result ? `<b>${escapeAchievement(item.result)}</b>` : ""}${item.link ? `<a href="${escapeAchievement(item.link)}" target="_blank" rel="noopener noreferrer">Підтвердження ↗</a>` : ""}</div><p>${escapeAchievement(item.description) || "Деталі не додані"}</p><small>${item.is_public ? "Публічне" : "Приватне"}</small></div>
      <button class="achievement-delete" type="button" data-achievement-id="${item.id}">Видалити</button>
    </article>`).join("")
}

async function loadMyAchievements() {
  const response = await fetch("/api/achievements/mine")
  if (!response.ok) throw new Error("Не вдалося завантажити досягнення")
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
      if (response.status === 404) throw new Error("Сервер ще не має оновленого імпорту Google Таблиць (HTTP 404). Перезапусти або онови сервер порталу.")
      if (response.redirected || contentType.includes("text/html")) throw new Error("Сервер повернув сторінку замість відповіді API. Онови сторінку й увійди в акаунт повторно.")
      throw new Error(`Сервер повернув неочікувану відповідь (HTTP ${response.status}). Спробуй ще раз або звернися до адміністратора.`)
    }
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `Помилка сервера (HTTP ${response.status})`)
    return data
  }
  const selectedSheetRows = () => [...sheetRowsHost.querySelectorAll("[data-sheet-row]:checked")].map(input => previewRows[Number(input.dataset.sheetRow)])
  const updateSheetSelection = () => {
    const selected = selectedSheetRows().length
    sheetImportButton.textContent = `Імпортувати обрані (${selected})`
    const valid = previewRows.filter(row => !row.error).length
    sheetSelectAll.checked = selected > 0 && selected === valid
    sheetSelectAll.indeterminate = selected > 0 && selected < valid
  }
  sheetImportForm.addEventListener("submit", async event => {
    event.preventDefault()
    const submit = document.querySelector("#googleSheetPreviewButton")
    submit.disabled = true; submit.textContent = "Читаємо таблицю…"; sheetPreview.classList.add("hidden"); sheetMessageShow("")
    try {
      const response = await fetch("/api/achievements/google-sheet/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: sheetUrl.value.trim() }) })
      const data = await readSheetResponse(response)
      if (!Array.isArray(data.rows)) throw new Error("Сервер не повернув рядки таблиці. Онови сторінку й спробуй ще раз.")
      previewRows = data.rows || []
      const valid = previewRows.filter(row => !row.error).length
      sheetSummary.textContent = `${valid} коректних із ${previewRows.length} рядків${data.truncated ? ` · показано перші ${previewRows.length} із ${data.totalRows}` : ""}`
      sheetRowsHost.innerHTML = previewRows.map((row, index) => `<tr class="${row.error ? "is-error" : ""}"><td><input type="checkbox" data-sheet-row="${index}" ${row.error ? "disabled" : "checked"} aria-label="Обрати рядок ${row.row_number}"></td><td>${escapeAchievement(row.title || "—")}</td><td>${escapeAchievement(row.achievement_type || "Досягнення")}</td><td>${escapeAchievement(row.event_name || "—")}</td><td>${escapeAchievement(row.achievement_date || "—")}</td><td>${escapeAchievement(row.result || "—")}</td><td>${escapeAchievement(row.error || "Готово")}</td></tr>`).join("")
      sheetPreview.classList.remove("hidden"); updateSheetSelection()
      sheetMessageShow("Перегляньте записи й зніміть позначки з тих, які не потрібно додавати.")
    } catch (error) { sheetMessageShow(error.message, true) }
    finally { submit.disabled = false; submit.textContent = "Переглянути записи" }
  })
  sheetRowsHost.addEventListener("change", updateSheetSelection)
  sheetSelectAll.addEventListener("change", () => { sheetRowsHost.querySelectorAll("[data-sheet-row]:not(:disabled)").forEach(input => { input.checked = sheetSelectAll.checked }); updateSheetSelection() })
  sheetImportButton.addEventListener("click", async () => {
    const selected = selectedSheetRows()
    if (!selected.length) { sheetMessageShow("Оберіть хоча б один коректний рядок.", true); return }
    sheetImportButton.disabled = true; sheetImportButton.textContent = "Імпортуємо…"
    try {
      const response = await fetch("/api/achievements/google-sheet/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: selected }) })
      const data = await readSheetResponse(response)
      sheetMessageShow(data.message || "Імпорт завершено.")
      sheetPreview.classList.add("hidden"); previewRows = []
      await loadMyAchievements()
    } catch (error) { sheetMessageShow(error.message, true) }
    finally { sheetImportButton.disabled = false }
  })
}

function readAchievementPhoto() {
  const file = achievementEls.photo.files[0]
  if (!file) return Promise.resolve("")
  if (file.size > 4 * 1024 * 1024) return Promise.reject(new Error("Фото досягнення не може перевищувати 4 МБ"))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error("Не вдалося прочитати фото"))
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
    if (!response.ok) throw new Error(data.error || "Не вдалося зберегти досягнення")
    achievementEls.form.reset()
    const elapsed = finishTimer()
    showAchievementAlert("Досягнення додано", true)
    setAchievementProgress(`Готово за ${elapsed} с. Вікно можна закрити.`)
    await loadMyAchievements()
  } catch (error) {
    const elapsed = finishTimer()
    showAchievementAlert(error.message)
    setAchievementProgress(`Не вдалося зберегти за ${elapsed} с. Перевірте дані та спробуйте ще раз.`)
  } finally {
    submitButton.disabled = false
  }
})

achievementEls.list.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-achievement-id]")
  if (!button) return
  const response = await fetch(`/api/achievements/${button.dataset.achievementId}`, { method: "DELETE" })
  if (!response.ok) return showAchievementAlert("Не вдалося видалити досягнення")
  await loadMyAchievements()
})

achievementEls.openButton.addEventListener("click", () => toggleAchievementDialog(true))
document.querySelectorAll("[data-close-achievement]").forEach((element) => element.addEventListener("click", () => toggleAchievementDialog(false)))
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleAchievementDialog(false)
})

loadMyAchievements().catch((error) => showAchievementAlert(error.message))
