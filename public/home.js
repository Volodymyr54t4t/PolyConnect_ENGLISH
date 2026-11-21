const $ = (sel) => document.querySelector(sel)

const els = {
    profileBanner: $("#profileBanner"),
    bannerCta: $("#bannerCta"),
    navProfile: $("#navProfile"),
    deanDashboardLink: $("#deanDashboardLink"),
    mailCenterLink: $("#mailCenterLink"),
    openProfileBtn: $("#openProfileBtn"),
    // Верхня панель
    chipAvatar: $("#chipAvatar"),
    chipName: $("#chipName"),
    // Привітання
    welcomeName: $("#welcomeName"),
    welcomeRole: $("#welcomeRole"),
    metaEmail: $("#metaEmail"),
    heroAccountName: $("#heroAccountName"),
    metaStatus: $("#metaStatus"),
    // Картка профілю
    profileHint: $("#profileHint"),
    factEmail: $("#factEmail"),
    factRole: $("#factRole"),
    factGroupRow: $("#factGroupRow"),
    factGroup: $("#factGroup"),
    factStatus: $("#factStatus"),
    // Навігація
    navlinks: document.querySelectorAll(".navlink"),
    homeNews: $("#homeNews"),
    homeEvents: $("#homeEvents"),
    homePolls: $("#homePolls"),
}

// Куди веде сторінка профілю (залежить від ролі)
let profileUrl = "/profileStudent"

async function apiJson(path, method, body) {
    const res = await fetch(path, {
        method,
        headers: {
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || "Something went wrong")
    return data
}

function renderUser(user) {
    const isStudent = user.role === "Студент"
    profileUrl = user.redirect || (isStudent ? "/profileStudent" : "/profileTeacher")

    const initial = (user.full_name || "?").trim().charAt(0).toUpperCase()
    els.chipAvatar.textContent = initial
    els.chipName.textContent = user.full_name
    els.heroAccountName.textContent = user.full_name || "User"
    els.welcomeName.textContent = user.full_name
    els.welcomeRole.textContent = user.role
    els.metaEmail.textContent = user.email

    // Картка профілю
    els.factEmail.textContent = user.email
    els.factRole.textContent = user.role
    els.factGroupRow.classList.toggle("hidden", !isStudent)
    els.factGroup.textContent = user.group_name || "—"
    els.openProfileBtn.setAttribute("href", profileUrl)
    const canOpenAdmin = ["ДеканФІКТ", "Розробник", "Завідувач Кафедри"].includes(user.role)
    els.deanDashboardLink.classList.toggle("hidden", !canOpenAdmin)
    const canSendMail = ["ДеканФІКТ", "Розробник", "Завідувач Кафедри", "Викладач"].includes(user.role)
    els.mailCenterLink.classList.toggle("hidden", !canSendMail)
    if (canOpenAdmin) {
        els.deanDashboardLink.href = user.role === "Розробник" ? "/admin" : user.role === "Завідувач Кафедри" ? "/profiles-review" : "/dean-dashboard"
        els.deanDashboardLink.textContent = user.role === "Розробник" ? "Адмін-панель" : user.role === "Завідувач Кафедри" ? "Профілі кафедри" : "Дашборд"
    }

    // Статус профілю + банер
    if (user.profile_complete) {
        els.metaStatus.textContent = "Заповнено"
        els.metaStatus.classList.add("is-ok")
        els.metaStatus.classList.remove("is-warn")
        els.factStatus.textContent = "Заповнено"
        els.profileHint.textContent = "Ваш профіль заповнено. Ви можете переглянути або оновити його."
        els.profileBanner.classList.add("hidden")
    } else {
        els.metaStatus.textContent = "Не заповнено"
        els.metaStatus.classList.add("is-warn")
        els.metaStatus.classList.remove("is-ok")
        els.factStatus.textContent = "Не заповнено"
        els.profileHint.textContent = "Профіль ще не заповнений — заповніть обов'язкові поля."
        els.profileBanner.classList.remove("hidden")
    }
}

function renderHomeNews(news) {
    if (!els.homeNews) return
    const items = (news || []).slice(0, 3)
    if (!items.length) {
        els.homeNews.innerHTML = '<p class="updates-state">No news yet. Тут з’являться останні department announcements.</p>'
        return
    }
    els.homeNews.replaceChildren(...items.map((item) => {
        const link = document.createElement("a")
        link.className = "update-item"
        link.href = "/news"
        const date = document.createElement("span")
        date.className = "update-item__date"
        date.textContent = item.created_at ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(item.created_at)) : "Оголошення кафедри"
        const title = document.createElement("strong")
        title.className = "update-item__title"
        title.textContent = item.title || "Untitled"
        const excerpt = document.createElement("span")
        excerpt.className = "update-item__excerpt"
        const plainText = new DOMParser().parseFromString(item.content || "", "text/html")
        excerpt.textContent = (plainText.body.textContent || "Read the full announcement").trim().slice(0, 110)
        link.append(date, title, excerpt)
        return link
    }))
}

async function loadHomeNews() {
    if (!els.homeNews) return
    try {
        const response = await fetch("/api/news")
        if (!response.ok) throw new Error("News are unavailable")
        const data = await response.json()
        renderHomeNews(data.news)
        $("#statNews").textContent = String((data.news || []).filter((item) => item.status === "published").length)
    } catch {
        els.homeNews.innerHTML = '<p class="updates-state">Could not load news. <a href="/news">Go to news →</a></p>'
    }
}

function renderHomeEvents(events) {
    const now = Date.now()
    const upcoming = (events || []).filter((event) => event.status === "published" && new Date(event.starts_at).getTime() >= now).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)).slice(0, 3)
    $("#statEvents").textContent = String(upcoming.length)
    if (!upcoming.length) { els.homeEvents.innerHTML = '<p class="feed-empty">No upcoming events yet. Check the calendar again later.</p>'; return }
    els.homeEvents.replaceChildren(...upcoming.map((event) => {
        const row = document.createElement("a"); row.className = "feed-event"; row.href = "/events"
        const date = new Date(event.starts_at)
        const dateBox = document.createElement("span"); dateBox.className = "feed-event__date"
        dateBox.innerHTML = `<b>${new Intl.DateTimeFormat("en-US", { day: "2-digit" }).format(date)}</b><small>${new Intl.DateTimeFormat("en-US", { month: "short" }).format(date).replace(".", "")}</small>`
        const details = document.createElement("span"); details.className = "feed-event__details"
        const title = document.createElement("b"); title.textContent = event.title || "University event"
        const meta = document.createElement("small"); meta.textContent = `${new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(date)} · ${event.format === "online" ? "Online" : (event.location || "University")}`
        details.append(title, meta); row.append(dateBox, details); return row
    }))
}

function renderHomePolls(polls) {
    const active = (polls || []).filter((poll) => poll.can_vote || (poll.status === "published" && !poll.is_closed)).slice(0, 2)
    $("#statPolls").textContent = String(active.length)
    if (!active.length) { els.homePolls.innerHTML = '<p class="feed-empty">There are no open polls right now. New polls will appear here.</p>'; return }
    els.homePolls.replaceChildren(...active.map((poll) => {
        const row = document.createElement("a"); row.className = "feed-poll"; row.href = "/polls"
        const icon = document.createElement("span"); icon.className = "feed-poll__icon"; icon.textContent = poll.voted ? "✓" : "◉"
        const details = document.createElement("span"); details.className = "feed-poll__details"
        const title = document.createElement("b"); title.textContent = poll.title || "Опитування"
        const meta = document.createElement("small"); meta.textContent = poll.voted ? "You have voted · view" : "Open poll · participate"
        details.append(title, meta); row.append(icon, details); return row
    }))
}

async function loadCampusOverview() {
    $("#homeToday").textContent = new Intl.DateTimeFormat("en-US", { weekday: "long", day: "numeric", month: "long" }).format(new Date())
    const results = await Promise.allSettled([fetch("/api/events").then((r) => r.ok ? r.json() : Promise.reject()), fetch("/api/polls").then((r) => r.ok ? r.json() : Promise.reject())])
    if (results[0].status === "fulfilled") renderHomeEvents(results[0].value.events)
    else { els.homeEvents.innerHTML = '<p class="feed-empty">Календар тимчасово недоступний. <a href="/events">Відкрити події →</a></p>'; $("#statEvents").textContent = "0" }
    if (results[1].status === "fulfilled") renderHomePolls(results[1].value.polls)
    else { els.homePolls.innerHTML = '<p class="feed-empty">Опитування temporarily unavailable. <a href="/polls">Open section →</a></p>'; $("#statPolls").textContent = "0" }
}

async function init() {
    try {
        const res = await fetch("/api/me")
        if (!res.ok) {
            window.location.href = "/"
            return
        }
        const data = await res.json()
        renderUser(data.user)
    } catch {
        window.location.href = "/"
    }
}

function goToProfile(e) {
    if (e) e.preventDefault()
    window.location.href = profileUrl
}

els.bannerCta.addEventListener("click", goToProfile)
els.navProfile.addEventListener("click", goToProfile)
els.openProfileBtn.addEventListener("click", goToProfile)

// Старт
init()
loadHomeNews()
loadCampusOverview()
