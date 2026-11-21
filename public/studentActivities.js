const activityForm = document.querySelector("#activityForm")
const activityCategory = document.querySelector("#activityCategory")
const activityList = document.querySelector("#myActivities")
const activityAlert = document.querySelector("#activityAlert")

const escapeActivity = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]))
const activityDate = (value) => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value)) : "Date not specified"
function activityMessage(message, ok = false) { activityAlert.textContent = message; activityAlert.style.color = ok ? "var(--ok)" : "var(--danger)" }

async function activityRequest(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || "Something went wrong")
  return data
}
async function loadActivityCategories(selectedName = "") {
  const data = await activityRequest("/api/activity-categories")
  activityCategory.innerHTML = `<option value="">Select a category</option>${(data.categories || []).map((item) => `<option value="${escapeActivity(item.name)}" ${item.name === selectedName ? "selected" : ""}>${escapeActivity(item.name)}</option>`).join("")}`
}
function renderActivities(items) {
  if (!items.length) { activityList.innerHTML = '<p class="form-alert">Add your first activity to start building your portfolio.</p>'; return }
  activityList.innerHTML = items.map((item) => `<article class="activity-card"><div><span class="activity-card__tag">${escapeActivity(item.category_name)}</span><h3>${escapeActivity(item.title)}</h3><p class="activity-card__meta">${activityDate(item.activity_date)} · ${escapeActivity(item.organizer || "Organizer not specified")}</p>${item.location ? `<p class="activity-card__meta">${escapeActivity(item.location)}</p>` : ""}${item.description ? `<p>${escapeActivity(item.description)}</p>` : ""}${item.link ? `<a class="text-link" href="${escapeActivity(item.link)}" target="_blank" rel="noopener">Proof ↗</a>` : ""}</div><div class="activity-card__side"><small>${item.is_public ? "Public" : "Private"}</small><button class="achievement-delete" type="button" data-activity-id="${item.id}">Delete</button></div></article>`).join("")
}
async function loadActivities() { const data = await activityRequest("/api/student-activities/mine"); renderActivities(data.activities || []) }

activityForm.addEventListener("submit", async (event) => {
  event.preventDefault(); const formData = new FormData(activityForm); const customCategory = document.querySelector("#newActivityCategory").value.trim()
  const categoryName = customCategory || formData.get("category_name")
  try {
    const data = await activityRequest("/api/student-activities", { method: "POST", body: JSON.stringify({ title: formData.get("title"), category_name: categoryName, organizer: formData.get("organizer"), location: formData.get("location"), activity_date: formData.get("activity_date"), description: formData.get("description"), link: formData.get("link"), is_public: formData.get("is_public") === "on" }) })
    activityForm.reset(); await loadActivityCategories(data.activity.category_name); await loadActivities(); activityMessage("Activity added", true)
  } catch (error) { activityMessage(error.message) }
})
activityList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-activity-id]"); if (!button) return
  try { await activityRequest(`/api/student-activities/${button.dataset.activityId}`, { method: "DELETE" }); await loadActivities() } catch (error) { activityMessage(error.message) }
})
Promise.all([loadActivityCategories(), loadActivities()]).catch((error) => activityMessage(error.message))
