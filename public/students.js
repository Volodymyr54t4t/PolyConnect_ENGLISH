const $ = (selector) => document.querySelector(selector)
let students = [], activityCategories = [], activeCategory = "all"
const staffRoles = ["Розробник", "ДеканФІКТ", "Завідувач Кафедри", "Викладач"]
const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]))
const date = (value) => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value)) : ""
function render() {
  const categories = [...new Set([...activityCategories, ...students.flatMap((student) => student.activities.map((activity) => activity.category_name))])].sort()
  $("#studentFilters").innerHTML = [`<button class="student-filter ${activeCategory === "all" ? "active" : ""}" data-category="all">All activities</button>`, ...categories.map((category) => `<button class="student-filter ${activeCategory === category ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`)].join("")
  const cards = students.map((student) => ({ ...student, activities: student.activities.filter((activity) => activeCategory === "all" || activity.category_name === activeCategory) })).filter((student) => student.activities.length)
  $("#studentsList").innerHTML = cards.length ? cards.map((student) => `<article class="student-card"><header><div class="student-avatar">${student.photo ? `<img src="${student.photo}" alt="">` : escapeHtml((student.full_name || "?").trim().charAt(0))}</div><div class="student-card__identity"><h2>${escapeHtml(student.full_name)}</h2><p>${escapeHtml([student.group_name, student.study_level, student.course && `${student.course} year`].filter(Boolean).join(" · ") || "Student")}</p>${window.presenceMarkup?.(student.presence_status, student.status_message) || ""}</div></header><div class="student-activity-list">${student.activities.map((activity) => `<section><span>${escapeHtml(activity.category_name)}</span><h3>${escapeHtml(activity.title)}</h3><p>${escapeHtml([date(activity.activity_date), activity.organizer, activity.location].filter(Boolean).join(" · "))}</p>${activity.description ? `<p>${escapeHtml(activity.description)}</p>` : ""}${activity.link ? `<a href="${escapeHtml(activity.link)}" target="_blank" rel="noopener">More details ↗</a>` : ""}</section>`).join("")}</div></article>`).join("") : '<p class="empty">No public activities match this filter yet.</p>'
}
function openExtract() {
  const categories = [...new Set([...activityCategories, ...students.flatMap((student) => student.activities.map((activity) => activity.category_name))])].sort()
  $("#extractStudent").innerHTML = `<option value="all">All students</option>${students.map((student) => `<option value="${student.id}">${escapeHtml(student.full_name)}${student.group_name ? ` (${escapeHtml(student.group_name)})` : ""}</option>`).join("")}`
  $("#extractCategories").innerHTML = categories.map((category) => `<label class="extract-category"><input type="checkbox" value="${escapeHtml(category)}" checked> ${escapeHtml(category)}</label>`).join("") || "<p>No public activities available for the extract.</p>"
  $("#studentExtractDialog").classList.remove("hidden")
}
function closeExtract() { $("#studentExtractDialog").classList.add("hidden") }
$("#studentFilters").onclick = (event) => { const button = event.target.closest("[data-category]"); if (!button) return; activeCategory = button.dataset.category; render() }
async function load() { const me = await fetch("/api/me"); if (!me.ok) { location.href = "/"; return }; const user = (await me.json()).user; $("#userName").textContent = user.full_name; $("#userAvatar").textContent = user.full_name.charAt(0); $("#navProfile").href = user.redirect; if (staffRoles.includes(user.role)) $("#studentExtractBtn").classList.remove("hidden"); const [studentsResponse, categoriesResponse] = await Promise.all([fetch("/api/students"), fetch("/api/activity-categories")]); const data = await studentsResponse.json().catch(() => ({})); const categoryData = await categoriesResponse.json().catch(() => ({})); if (!studentsResponse.ok) throw new Error(data.error || "Could not load students"); if (!categoriesResponse.ok) throw new Error(categoryData.error || "Could not load categories"); students = data.students || []; activityCategories = (categoryData.categories || []).map((category) => category.name); render() }
$("#studentExtractBtn").onclick = openExtract
document.querySelectorAll("[data-close-extract]").forEach((element) => { element.onclick = closeExtract })
$("#createStudentExtractBtn").onclick = () => {
  const studentId = $("#extractStudent").value
  const categories = Array.from(document.querySelectorAll("#extractCategories input:checked")).map((input) => input.value)
  if (!categories.length) { window.alert("Select at least one activity category."); return }
  const params = new URLSearchParams({ student_id: studentId, categories: categories.join(",") })
  window.open(`/students/export?${params.toString()}`, "_blank", "noopener")
}
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeExtract() })
load().catch(() => { $("#studentsList").innerHTML = '<p class="empty">Could not load students.</p>' })
window.setInterval(() => load().catch(() => {}), 60_000)
