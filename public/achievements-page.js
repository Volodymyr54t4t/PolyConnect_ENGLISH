const feed = document.querySelector("#achievementFeed")
const filters = document.querySelectorAll(".achievement-filter")
const detail = document.querySelector("#achievementDetail")
const detailMedia = document.querySelector("#detailAchievementMedia")
const detailMeta = document.querySelector("#detailAchievementMeta")
const detailTitle = document.querySelector("#detailAchievementTitle")
const detailDescription = document.querySelector("#detailAchievementDescription")
const detailAuthor = document.querySelector("#detailAchievementAuthor")
const detailFacts = document.querySelector("#detailAchievementFacts")
let achievementItems = []

function escapeFeed(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char])
}

function roleGroup(role) {
  if (role === "Студент") return "Студенти"
  if (role === "Викладач") return "Викладачі"
  return "Деканат"
}

function renderFeed(items) {
  achievementItems = items
  if (!items.length) {
    feed.innerHTML = '<p class="achievement-empty">Публічних досягнень у цій категорії ще немає.</p>'
    return
  }
  feed.innerHTML = items.map((item) => `
    <article class="achievement-card" tabindex="0" role="button" data-achievement-id="${item.id}">
      <div class="achievement-card__media">${item.photo ? `<img src="${item.photo}" alt="" loading="lazy" />` : `<span>${escapeFeed(item.full_name).charAt(0).toUpperCase()}</span>`}</div>
      <div class="achievement-card__body"><div class="achievement-card__meta"><span>${escapeFeed(item.achievement_type || "Досягнення")}</span><span>${escapeFeed(roleGroup(item.role))}</span></div><h2>${escapeFeed(item.title)}</h2><p>${escapeFeed(item.event_name || item.result || item.description) || "Досягнення учасника спільноти ФІКТ."}</p><strong>${escapeFeed(item.full_name)}</strong></div>
    </article>`).join("")
}

function openDetail(item) {
  detailMedia.innerHTML = item.photo ? `<img src="${item.photo}" alt="Повне фото досягнення" />` : `<span>${escapeFeed(item.full_name).charAt(0).toUpperCase()}</span>`
  detailMeta.textContent = `${item.achievement_type || "Досягнення"} · ${roleGroup(item.role)} · ${item.role}`
  detailTitle.textContent = item.title
  detailDescription.textContent = item.description || "Досягнення учасника спільноти ФІКТ."
  detailAuthor.textContent = item.full_name
  const facts = [["Подія", item.event_name], ["Дата", item.achievement_date ? new Intl.DateTimeFormat("en-US", { dateStyle: "long" }).format(new Date(item.achievement_date)) : ""], ["Організатор", item.organizer], ["Місце", item.location], ["Результат / роль", item.result]].filter(([, value]) => value)
  detailFacts.replaceChildren(...facts.map(([label, value]) => {
    const row = document.createElement("p")
    const key = document.createElement("b")
    key.textContent = label
    const content = document.createElement("span")
    content.textContent = value
    row.append(key, content)
    return row
  }))
  if (item.link && /^https?:\/\//i.test(item.link)) {
    const link = document.createElement("a")
    link.href = item.link; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = "Доказ / посилання на результат ↗"
    detailFacts.append(link)
  }
  detail.classList.remove("hidden")
  document.body.classList.add("modal-open")
}

function closeDetail() {
  detail.classList.add("hidden")
  document.body.classList.remove("modal-open")
}

async function loadFeed(role = "all") {
  feed.innerHTML = '<p class="achievement-empty">Завантаження досягнень…</p>'
  const query = role === "all" ? "" : `?role=${encodeURIComponent(role)}`
  try {
    const response = await fetch(`/api/achievements${query}`)
    if (!response.ok) throw new Error("Не вдалося завантажити досягнення")
    const data = await response.json()
    renderFeed(data.achievements || [])
  } catch (error) {
    feed.innerHTML = `<p class="achievement-empty">${escapeFeed(error.message)}</p>`
  }
}

filters.forEach((button) => button.addEventListener("click", () => {
  filters.forEach((item) => item.classList.remove("is-active"))
  button.classList.add("is-active")
  loadFeed(button.dataset.role)
}))

feed.addEventListener("click", (event) => {
  const card = event.target.closest("[data-achievement-id]")
  if (card) openDetail(achievementItems.find((item) => String(item.id) === card.dataset.achievementId))
})

feed.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return
  const card = event.target.closest("[data-achievement-id]")
  if (card) {
    event.preventDefault()
    openDetail(achievementItems.find((item) => String(item.id) === card.dataset.achievementId))
  }
})

document.querySelectorAll("[data-close-detail]").forEach((element) => element.addEventListener("click", closeDetail))
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDetail()
})

async function initAchievementsPage() {
  try {
    const response = await fetch("/api/me")
    if (!response.ok) return (window.location.href = "/")
    const { user } = await response.json()
    document.querySelector("#userName").textContent = user.full_name || "User"
    document.querySelector("#userAvatar").textContent = (user.full_name || "?").trim().charAt(0).toUpperCase()
    document.querySelector("#navProfile").href = user.redirect || (user.role === "Викладач" ? "/profileTeacher" : "/profileStudent")
    loadFeed()
  } catch {
    window.location.href = "/"
  }
}

initAchievementsPage()
