const $ = (sel) => document.querySelector(sel)

const els = {
  loader: $("#loader"),
  app: $("#app"),
  alert: $("#alert"),
  form: $("#profileForm"),
  logoutBtn: $("#logoutBtn"),
  photoInput: $("#photoInput"),
  photoPreview: $("#photoPreview"),
  photoPlaceholder: $("#photoPlaceholder"),
  viewName: $("#viewName"),
  viewEmail: $("#viewEmail"),
  viewGroup: $("#viewGroup"),
  viewStudyLevel: $("#viewStudyLevel"),
  viewCourse: $("#viewCourse"),
  viewPhone: $("#viewPhone"),
  viewAbout: $("#viewAbout"),
  viewSocial: $("#viewSocial"),
  emailField: $("#emailField"),
  chipAvatar: $("#chipAvatar"),
  chipName: $("#chipName"),
}

let photoData = null // base64 нового фото

function showAlert(message, ok = false) {
  if (window.modalAlert) return modalAlert(message)
  els.alert.textContent = message
  els.alert.classList.remove("hidden", "is-ok", "is-err")
  els.alert.classList.add(ok ? "is-ok" : "is-err")
  els.alert.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  })
}

function setPhoto(src) {
  if (src) {
    els.photoPreview.src = src
    els.photoPreview.classList.remove("hidden")
    els.photoPlaceholder.classList.add("hidden")
  } else {
    els.photoPreview.classList.add("hidden")
    els.photoPlaceholder.classList.remove("hidden")
  }
}

function fillView(user) {
  // Верхня панель: аватар + ім'я
  els.chipAvatar.textContent = (user.full_name || "?").trim().charAt(0).toUpperCase()
  els.chipName.textContent = user.full_name || "—"

  els.viewName.textContent = user.full_name || "—"
  els.viewEmail.textContent = user.email || "—"
  els.viewGroup.textContent = user.group_name || "—"
  els.viewStudyLevel.textContent = user.study_level || "—"
  els.viewCourse.textContent = user.course ? `${user.course} курс` : "—"
  els.viewPhone.textContent = user.phone || "—"
  els.viewAbout.textContent = user.about || "Додайте коротку інформацію про себе у форму профілю."
  renderProfileLinks(user)
  els.photoPlaceholder.textContent = (user.full_name || "Ф").trim().charAt(0).toUpperCase()

  els.emailField.value = user.email || ""
  els.form.full_name.value = user.full_name || ""
  els.form.phone.value = user.phone || ""
  els.form.group_name.value = user.group_name || ""
  els.form.study_level.value = user.study_level || ""
  els.form.course.value = user.course || ""
  els.form.about.value = user.about || ""
  els.form.github_url.value = user.github_url || ""
  els.form.linkedin_url.value = user.linkedin_url || ""
  els.form.portfolio_url.value = user.portfolio_url || ""
  setPhoto(user.photo)
}

function renderProfileLinks(user) {
  const links = [["GitHub", user.github_url], ["LinkedIn", user.linkedin_url], ["Портфоліо", user.portfolio_url]]
    .filter(([, url]) => /^https?:\/\//i.test(url || ""))
  els.viewSocial.replaceChildren(...links.map(([label, url]) => {
    const link = document.createElement("a")
    link.href = url
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    link.textContent = `${label} ↗`
    return link
  }))
  els.viewSocial.classList.toggle("hidden", !links.length)
}

async function load() {
  try {
    const res = await fetch("/api/me")
    if (!res.ok) {
      window.location.href = "/"
      return
    }
    const data = await res.json()
    // Не той тип профілю — перенаправляємо
    if (data.user.role !== "Студент") {
      window.location.href = data.redirect || "/"
      return
    }
    fillView(data.user)
    els.loader.classList.add("hidden")
    els.app.classList.remove("hidden")
  } catch {
    window.location.href = "/"
  }
}

// Завантаження фото → base64
els.photoInput.addEventListener("change", (e) => {
  const file = e.target.files[0]
  if (!file) return
  if (file.size > 4 * 1024 * 1024) {
    showAlert("Файл завеликий. Максимум 4 МБ.")
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    photoData = reader.result
    setPhoto(photoData)
  }
  reader.readAsDataURL(file)
})

// Збереження профілю
els.form.addEventListener("submit", async (e) => {
  e.preventDefault()
  const fd = new FormData(els.form)
  const body = {
    full_name: fd.get("full_name"),
    phone: fd.get("phone"),
    group_name: fd.get("group_name"),
    study_level: fd.get("study_level"),
    course: fd.get("course"),
    about: fd.get("about"),
    github_url: fd.get("github_url"),
    linkedin_url: fd.get("linkedin_url"),
    portfolio_url: fd.get("portfolio_url"),
  }
  if (photoData) body.photo = photoData

  try {
    const res = await fetch("/api/profile", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || "Помилка збереження")
    photoData = null
    fillView(data.user)
    showAlert("Профіль успішно збережено", true)
  } catch (err) {
    showAlert(err.message)
  }
})

// Вихід
els.logoutBtn.addEventListener("click", async () => {
  try {
    await fetch("/api/logout", {
      method: "POST"
    })
  } catch {
    /* ignore */
  }
  window.location.href = "/"
})

load()
