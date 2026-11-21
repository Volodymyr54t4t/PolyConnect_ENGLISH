const $ = (selector) => document.querySelector(selector)
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]))
let profiles = []

function renderStudentProgress(students = []) {
  const host = $("#studentProgressList")
  if (!students.length) { host.innerHTML = '<div class="student-progress-empty">There are no students in this department yet.</div>'; return }
  host.innerHTML = students.map(student => {
    const count = Number(student.activity_count || 0)
    const percent = Math.min(count, 10) * 10
    const details = [student.group_name, student.course ? `${student.course} year` : ""].filter(Boolean).join(" · ") || "Group not specified"
    return `<article class="student-progress-card"><div><div class="student-progress-name">${esc(student.full_name)}</div><div class="student-progress-meta">${esc(details)} · Activities: ${count}</div></div><div class="student-progress-meter" role="progressbar" aria-label="Activity progress for ${esc(student.full_name)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><div class="student-progress-value">${percent}%</div></article>`
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
  if (!visible.length) { host.innerHTML = '<div class="review-empty">No profiles match these filters.</div>'; return }
  host.innerHTML = visible.map(p => {
    const missing = p.missing_fields.length
    const fields = [["Department", p.department], ["Position", p.position], ["Group", p.group_name], ["Level", p.study_level], ["Year", p.course], ["Phone", p.phone], ["About", p.about]]
      .filter(([, value]) => value).map(([label, value]) => `<span class="complete">${esc(label)}: ${esc(value)}</span>`).join("")
    const missingPills = p.missing_fields.map(field => `<span>${esc(field)} missing</span>`).join("")
    return `<article class="profile-card"><div><div class="profile-name">${esc(p.full_name)}</div><div class="profile-meta">${esc(p.role)}<br>${esc(p.email)}<br>${esc(p.department || "Department not specified")}</div></div><div><b>${missing ? `Missing: ${missing}` : "Profile complete"}</b><div class="profile-meta">${p.profile_updated_at ? `Last updated: ${new Date(p.profile_updated_at).toLocaleDateString("en-US")}` : "Profile has not been updated yet"}</div></div><div class="profile-fields">${fields}${missingPills}${!missing ? '<span class="complete">All обов’язкові поля заповнено</span>' : ""}</div><button class="admin-primary review-send" type="button" data-remind="${p.id}" ${!missing ? "disabled" : ""}>${missing ? "Send reminder" : "Complete"}</button></article>`
  }).join("")
}

async function load() {
  try {
    const me = await fetch("/api/me"); if (!me.ok) { location.href = "/"; return }
    const user = (await me.json()).user
    $("#userName").textContent = user.full_name || "User"
    $("#userAvatar").textContent = (user.full_name || "?").trim().charAt(0).toUpperCase()
    if (!["Розробник", "Завідувач Кафедри"].includes(user.role)) { location.href = "/home"; return }
    const response = await fetch("/api/profiles-review"), data = await response.json()
    if (!response.ok) throw new Error(data.error || "Could not load profiles")
    profiles = data.profiles || []
    renderStudentProgress(data.students || [])
    $("#totalCount").textContent = data.summary.total
    $("#completeCount").textContent = data.summary.complete
    $("#incompleteCount").textContent = data.summary.incomplete
    render()
  } catch (error) { flash(error.message, true); $("#profileList").innerHTML = '<div class="review-empty">Could not load the list. Refresh the page or try again later.</div>' }
}

$("#searchProfiles").addEventListener("input", render)
$("#statusFilter").addEventListener("change", render)
$("#profileList").addEventListener("click", async event => {
  const button = event.target.closest("[data-remind]"); if (!button) return
  button.disabled = true; button.textContent = "Sending…"
  try {
    const response = await fetch(`/api/profiles-review/${button.dataset.remind}/remind`, { method: "POST" })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || "Could not send email")
    flash(data.message); button.textContent = "Sent ✓"
  } catch (error) { flash(error.message, true); button.disabled = false; button.textContent = "Try again" }
})
load()
