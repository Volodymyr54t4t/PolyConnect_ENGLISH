const $ = (selector) => document.querySelector(selector)
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]))
let profiles = []

function renderStudentProgress(students = []) {
  const host = $("#studentProgressList")
  if (!students.length) { host.innerHTML = '<div class="student-progress-empty">Студентів кафедри поки немає.</div>'; return }
  host.innerHTML = students.map(student => {
    const count = Number(student.activity_count || 0)
    const percent = Math.min(count, 10) * 10
    const details = [student.group_name, student.course ? `${student.course} курс` : ""].filter(Boolean).join(" · ") || "Групу не вказано"
    return `<article class="student-progress-card"><div><div class="student-progress-name">${esc(student.full_name)}</div><div class="student-progress-meta">${esc(details)} · Активностей: ${count}</div></div><div class="student-progress-meter" role="progressbar" aria-label="Прогрес активностей ${esc(student.full_name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><div class="student-progress-value">${percent}%</div></article>`
  }).join("")
}

function flash(message, error = false) { const el = $("#reviewMessage"); el.textContent = message; el.classList.remove("hidden"); el.classList.toggle("error", error) }
function render() {
  const query = $("#searchProfiles").value.trim().toLocaleLowerCase("uk")
  const filter = $("#statusFilter").value
  const visible = profiles.filter(p => {
    const complete = p.missing_fields.length === 0
    const matchesStatus = filter === "all" || (filter === "complete") === complete
    return matchesStatus && `${p.full_name} ${p.email} ${p.department} ${p.role}`.toLocaleLowerCase("uk").includes(query)
  })
  const host = $("#profileList")
  if (!visible.length) { host.innerHTML = '<div class="review-empty">За цими умовами профілів не знайдено.</div>'; return }
  host.innerHTML = visible.map(p => {
    const missing = p.missing_fields.length
    const fields = [["Кафедра", p.department], ["Посада", p.position], ["Група", p.group_name], ["Рівень", p.study_level], ["Курс", p.course], ["Телефон", p.phone], ["Про себе", p.about]]
      .filter(([, value]) => value).map(([label, value]) => `<span class="complete">${esc(label)}: ${esc(value)}</span>`).join("")
    const missingPills = p.missing_fields.map(field => `<span>${esc(field)} не заповнено</span>`).join("")
    return `<article class="profile-card"><div><div class="profile-name">${esc(p.full_name)}</div><div class="profile-meta">${esc(p.role)}<br>${esc(p.email)}<br>${esc(p.department || "Кафедру не вказано")}</div></div><div><b>${missing ? `Не заповнено: ${missing}` : "Профіль повний"}</b><div class="profile-meta">${p.profile_updated_at ? `Остання зміна: ${new Date(p.profile_updated_at).toLocaleDateString("uk-UA")}` : "Профіль ще не оновлювали"}</div></div><div class="profile-fields">${fields}${missingPills}${!missing ? '<span class="complete">Усі обов’язкові поля заповнено</span>' : ""}</div><button class="admin-primary review-send" type="button" data-remind="${p.id}" ${!missing ? "disabled" : ""}>${missing ? "Надіслати нагадування" : "Усе заповнено"}</button></article>`
  }).join("")
}

async function load() {
  try {
    const me = await fetch("/api/me"); if (!me.ok) { location.href = "/"; return }
    const user = (await me.json()).user
    $("#userName").textContent = user.full_name || "Користувач"
    $("#userAvatar").textContent = (user.full_name || "?").trim().charAt(0).toUpperCase()
    if (!["Розробник", "Завідувач Кафедри"].includes(user.role)) { location.href = "/home"; return }
    const response = await fetch("/api/profiles-review"), data = await response.json()
    if (!response.ok) throw new Error(data.error || "Не вдалося завантажити профілі")
    profiles = data.profiles || []
    renderStudentProgress(data.students || [])
    $("#totalCount").textContent = data.summary.total
    $("#completeCount").textContent = data.summary.complete
    $("#incompleteCount").textContent = data.summary.incomplete
    render()
  } catch (error) { flash(error.message, true); $("#profileList").innerHTML = '<div class="review-empty">Не вдалося завантажити список. Оновіть сторінку або спробуйте пізніше.</div>' }
}

$("#searchProfiles").addEventListener("input", render)
$("#statusFilter").addEventListener("change", render)
$("#profileList").addEventListener("click", async event => {
  const button = event.target.closest("[data-remind]"); if (!button) return
  button.disabled = true; button.textContent = "Надсилаємо…"
  try {
    const response = await fetch(`/api/profiles-review/${button.dataset.remind}/remind`, { method: "POST" })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "Не вдалося надіслати лист")
    flash(data.message); button.textContent = "Надіслано ✓"
  } catch (error) { flash(error.message, true); button.disabled = false; button.textContent = "Спробувати ще раз" }
})
load()
