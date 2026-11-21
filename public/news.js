const $ = (selector) => document.querySelector(selector)
const list = $("#newsList"), editor = $("#editor"), form = $("#newsForm")
let currentUser = { role: "", id: null, full_name: "Guest" }
let allNews = [], categories = [], activeFilter = "all", lastTrigger = null
const authorRoles = ["Розробник", "ДеканФІКТ", "Завідувач Кафедри", "Викладач"]
const canPublish = () => authorRoles.includes(String(currentUser.role || "").trim())
const escapeHtml = (value) => String(value ?? "").replace(/[&<'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]))
const sanitizeContent = (value) => { const template = document.createElement("template"); template.innerHTML = String(value || ""); template.content.querySelectorAll("script,style,iframe,object,embed,form,link,meta").forEach((node) => node.remove()); template.content.querySelectorAll("*").forEach((node) => { Array.from(node.attributes).forEach((attribute) => { const name = attribute.name.toLowerCase(); const unsafeUrl = (name === "href" && !/^https?:|^mailto:|^tel:/i.test(attribute.value)) || (name === "src" && !/^https?:|^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(attribute.value)); if (name.startsWith("on") || name === "style" || unsafeUrl) node.removeAttribute(attribute.name) }); if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer") } }); return template.innerHTML }
const contentText = (value) => { const node = document.createElement("div"); node.innerHTML = sanitizeContent(value); return node.textContent || "" }
const categoryNames = (news) => (Array.isArray(news.categories) && news.categories.length ? news.categories : [{ name: news.category || "Announcements" }]).map((item) => item.name)
const normalizeCategories = (value) => Array.from(new Set(String(value || "").split(",").map((name) => name.trim().replace(/\s+/g, " ")).filter(Boolean))).slice(0, 12)

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw Error(data.error || "Something went wrong")
  return data
}
function formatDate(value) { return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) }
function renderFilters() {
  const filters = $("#newsFilters")
  const available = categories
  if (activeFilter !== "all" && !available.some((category) => category.name === activeFilter)) activeFilter = "all"
  filters.innerHTML = [`<button class="filter ${activeFilter === "all" ? "active" : ""}" data-filter="all" type="button">All</button>`, ...available.map((category) => `<button class="filter ${activeFilter === category.name ? "active" : ""}" data-filter="${escapeHtml(category.name)}" type="button">${escapeHtml(category.name)}${category.news_count ? ` <small>(${category.news_count})</small>` : ""}</button>`)].join("")
}
function categoryOptions(container, selected = []) {
  const selectedNames = new Set(selected)
  if (container.id === "categoryOptions") {
    container.innerHTML = categories.map((category) => `<option value="${escapeHtml(category.name)}" ${selectedNames.has(category.name) ? "selected" : ""}>${escapeHtml(category.name)}</option>`).join("")
    renderCategoryManagement()
    return
  }
  container.innerHTML = categories.map((category) => `<label class="category-option"><input type="checkbox" value="${escapeHtml(category.name)}" ${selectedNames.has(category.name) ? "checked" : ""}> ${escapeHtml(category.name)}</label>`).join("")
}
function selectedCategories() { return Array.from(document.querySelectorAll("#categoryOptions option:checked")).map((option) => option.value) }
function renderCategoryManagement() {
  const container = $("#categoryManagement")
  if (!container) return
  container.innerHTML = categories.map((category) => `<div class="category-management__row"><span>${escapeHtml(category.name)}${category.news_count ? ` (${category.news_count} news)` : ""}</span><span class="category-management__actions"><button type="button" data-rename-category="${category.id}">Rename</button><button type="button" data-delete-category="${category.id}">Delete</button></span></div>`).join("")
}
function render() {
  renderFilters()
  const items = allNews.filter((news) => activeFilter === "all" || categoryNames(news).includes(activeFilter))
  if (!items.length) { list.innerHTML = "<div class=\"empty\">There are no news in the selected categories yet.</div>"; return }
  list.innerHTML = items.map((news, index) => {
    const tags = categoryNames(news).map((name) => `<span class="news-tag">${escapeHtml(name)}</span>`).join("")
    const owned = canPublish() && news.author_id === currentUser.id
    return `<article class="news-card ${news.is_pinned ? "pinned" : ""} ${index === 0 ? "news-card--lead" : ""}"><div class="news-meta"><span>${news.is_pinned ? "Pinned" : escapeHtml(news.author_name || "")}</span><span>${formatDate(news.created_at)}</span></div><div class="news-tags">${tags}</div><h2>${escapeHtml(news.title)}</h2><p>${escapeHtml(contentText(news.content)).slice(0, 220)}${contentText(news.content).length > 220 ? "…" : ""}</p><button class="btn btn--primary news-details" data-details="${news.id}" type="button">Read news <span aria-hidden="true">→</span></button>${owned ? `<div class="news-actions"><button data-edit="${news.id}" type="button">Edit</button><button data-delete="${news.id}" type="button">Delete</button></div>` : ""}</article>`
  }).join("")
}
function openDetails(news) {
  $("#detailCategory").textContent = `${categoryNames(news).join(" · ")}${news.is_pinned ? " · Pinned" : ""}`
  $("#detailDate").textContent = `${formatDate(news.created_at)} · ${news.author_name || ""}`
  $("#detailTitle").textContent = news.title; $("#detailContent").innerHTML = sanitizeContent(news.content)
  $("#detailAttachments").innerHTML = news.attachments?.length ? news.attachments.map((attachment) => `<a href="/api/news/attachments/${attachment.id}" target="_blank">File: ${escapeHtml(attachment.file_name)}</a>`).join("<br>") : ""
  $("#newsDetail").classList.remove("hidden"); document.body.classList.add("modal-open")
}
function closeDetails() { $("#newsDetail").classList.add("hidden"); document.body.classList.remove("modal-open") }
function openEditor(news = null) {
  lastTrigger = document.activeElement; editor.classList.remove("hidden"); document.body.classList.add("modal-open"); $("#editorTitle").textContent = news ? "Edit news post" : "New story"
  $("#newsId").value = news?.id || ""; $("#title").value = news?.title || ""; categoryOptions($("#categoryOptions"), news ? categoryNames(news) : ["Announcements"])
  $("#content").innerHTML = sanitizeContent(news?.content || ""); $("#pinned").checked = Boolean(news?.is_pinned); $("#formAlert").textContent = ""
  setTimeout(() => $("#title").focus(), 0)
}
function closeEditor() { editor.classList.add("hidden"); document.body.classList.remove("modal-open"); form.reset(); $("#newsId").value = ""; lastTrigger?.focus?.() }
async function load() {
  try {
    try {
      const me = await request("/api/me"); currentUser = me.user
      $("#navProfile").href = currentUser.redirect || "/profileStudent"; $("#userName").textContent = currentUser.full_name || "User"
      $("#userChip .chip__avatar").textContent = (currentUser.full_name || "?").trim().charAt(0).toUpperCase()
      if (canPublish()) { $("#newBtn").classList.remove("hidden"); $("#exportBtn").classList.remove("hidden") }
    } catch { $("#userName").textContent = "Guest" }
    const [newsData, categoryData] = await Promise.all([request("/api/news"), request("/api/news/categories")])
    allNews = newsData.news || []; categories = categoryData.categories || []; render()
  } catch (error) { list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>` }
}
async function save(status) {
  try {
    const selected = selectedCategories()
    if (!selected.length) throw Error("Add at least one category or tag")
    const id = $("#newsId").value
    const content = sanitizeContent($("#content").innerHTML).trim()
    if (!content || !contentText(content).trim()) throw Error("Enter the news text")
    const body = { title: $("#title").value, categories: selected, content, is_pinned: $("#pinned").checked, status }
    const data = await request(id ? `/api/news/${id}` : "/api/news", { method: id ? "PUT" : "POST", body: JSON.stringify(body) })
    const file = $("#attachment").files[0]
    if (file && data.news?.id) {
      const reader = new FileReader()
      await new Promise((resolve, reject) => { reader.onload = resolve; reader.onerror = reject; reader.readAsDataURL(file) })
      await request(`/api/news/${data.news.id}/attachments`, { method: "POST", body: JSON.stringify({ file_name: file.name, mime_type: file.type || "application/octet-stream", file_data: reader.result }) })
    }
    closeEditor(); await load()
  } catch (error) { $("#formAlert").textContent = error.message }
}

let savedSelection = null
function rememberSelection() { const selection = window.getSelection(); if (selection?.rangeCount) savedSelection = selection.getRangeAt(0).cloneRange() }
function restoreSelection() { const selection = window.getSelection(); if (savedSelection) { selection.removeAllRanges(); selection.addRange(savedSelection) } $("#content").focus() }
function insertHtml(html) { restoreSelection(); document.execCommand("insertHTML", false, html); $("#content").dispatchEvent(new Event("input", { bubbles: true })) }
document.querySelectorAll(".wysiwyg-toolbar button, .wysiwyg-toolbar select").forEach((control) => { control.addEventListener("mousedown", (event) => { event.preventDefault(); rememberSelection() }); control.addEventListener("change", () => { restoreSelection(); document.execCommand(control.dataset.command, false, control.value); }); control.addEventListener("click", () => { const action = control.dataset.action; if (action === "link") { const url = window.prompt("Enter a link URL", "https://"); if (url && /^https?:\/\//i.test(url)) { restoreSelection(); document.execCommand("createLink", false, url) } return } if (action === "image") { rememberSelection(); $("#inlineImageInput").click(); return } restoreSelection(); document.execCommand(control.dataset.command, false, control.dataset.value || null); }) })
$("#inlineImageInput").addEventListener("change", (event) => { const file = event.target.files[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) { $("#formAlert").textContent = "The image must be no larger than 5 MB"; event.target.value = ""; return } const reader = new FileReader(); reader.onload = () => insertHtml(`<img src="${reader.result}" alt="${escapeHtml(file.name.replace(/\.[^.]+$/, ""))}" class="news-inline-image">`); reader.readAsDataURL(file); event.target.value = "" })
$("#content").addEventListener("paste", (event) => { const html = event.clipboardData?.getData("text/html"); if (!html) return; event.preventDefault(); insertHtml(sanitizeContent(html)); })
$("#content").addEventListener("input", () => { $("#content").classList.toggle("is-empty", !contentText($("#content").innerHTML).trim()) })
form.addEventListener("submit", (event) => { event.preventDefault(); save("published") })
$("#draftBtn").onclick = () => save("draft"); $("#newBtn").onclick = () => openEditor(); $("#closeEditor").onclick = closeEditor
document.querySelectorAll("[data-close-editor]").forEach((element) => { element.onclick = closeEditor })
$("#createCategoryBtn").onclick = async () => {
  try {
    const name = $("#newCategoryName").value.trim()
    if (!name) throw Error("Enter a name for the new category")
    const selected = selectedCategories(); const data = await request("/api/news/categories", { method: "POST", body: JSON.stringify({ name }) })
    if (!categories.some((category) => category.name === data.category.name)) categories.push({ ...data.category, news_count: 0 })
    $("#newCategoryName").value = ""; categoryOptions($("#categoryOptions"), [...selected, data.category.name]); renderFilters()
  } catch (error) { $("#formAlert").textContent = error.message }
}
$("#categoryManagement").onclick = async (event) => {
  const button = event.target.closest("button")
  if (!button) return
  const category = categories.find((item) => String(item.id) === button.dataset.renameCategory || String(item.id) === button.dataset.deleteCategory)
  if (!category) return
  try {
    if (button.dataset.renameCategory) {
      const name = window.prompt("New category name", category.name)?.trim()
      if (!name || name === category.name) return
      const data = await request(`/api/news/categories/${category.id}`, { method: "PUT", body: JSON.stringify({ name }) })
      category.name = data.category.name
      categoryOptions($("#categoryOptions"), selectedCategories().map((value) => value === category.name ? name : value))
      renderFilters(); render()
    } else if (button.dataset.deleteCategory && await modalConfirm(`Delete category «${category.name}»?`, { title: "Delete category", danger: true })) {
      await request(`/api/news/categories/${category.id}`, { method: "DELETE" })
      categories = categories.filter((item) => item.id !== category.id)
      categoryOptions($("#categoryOptions"), selectedCategories().filter((value) => value !== category.name)); renderFilters(); render()
    }
  } catch (error) { $("#formAlert").textContent = error.message }
}
$("#exportBtn").onclick = () => { categoryOptions($("#exportCategories"), categories.map((category) => category.name)); $("#exportDialog").classList.remove("hidden"); document.body.classList.add("modal-open") }
function closeExport() { $("#exportDialog").classList.add("hidden"); document.body.classList.remove("modal-open") }
document.querySelectorAll("[data-close-export]").forEach((element) => { element.onclick = closeExport })
$("#downloadPdfBtn").onclick = () => {
  const selected = Array.from(document.querySelectorAll("#exportCategories input:checked")).map((input) => input.value)
  if (!selected.length) { modalAlert("Select at least one category for the report"); return }
  window.open(`/news/export?categories=${encodeURIComponent(selected.join(","))}`, "_blank", "noopener")
}
$("#newsFilters").onclick = (event) => { const button = event.target.closest("[data-filter]"); if (!button) return; activeFilter = button.dataset.filter; render() }
list.onclick = async (event) => {
  const button = event.target.closest("button"); if (!button || !list.contains(button)) return
  const id = button.dataset.details || button.dataset.edit || button.dataset.delete; const news = allNews.find((item) => item.id == id)
  try {
    if (button.dataset.details && news) openDetails(news)
    else if (button.dataset.edit && news) openEditor(news)
    else if (button.dataset.delete && await modalConfirm("Delete this news post?", { title: "Delete news post", danger: true })) { await request(`/api/news/${id}`, { method: "DELETE" }); await load() }
  } catch (error) { modalAlert(error.message) }
}
document.querySelectorAll("[data-close-detail]").forEach((element) => { element.onclick = closeDetails })
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeDetails(); closeExport(); closeEditor() } })
load()
