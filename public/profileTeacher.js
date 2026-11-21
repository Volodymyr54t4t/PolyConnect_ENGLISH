const $ = (sel) => document.querySelector(sel)

// Посади (останній пункт — "Other")
const POSITIONS = [
  "Department Chair",
  "Vice-Rector for Academic Affairs and Associate Professor",
  "Professor",
  "Associate Professor",
  "Associate Professor (викладач-практик)",
  "Senior Lecturer",
  "Senior Lecturer (викладач-практик)",
  "Assistant Lecturer",
  "Assistant Lecturer (викладач-практик)",
  "Other",
]

// Список предметів кафедри ІПЗ
const SUBJECTS = [
  "Algorithms and Data Structures",
  "Discrete Structures",
  "Software Requirements Analysis",
  "Computer Architecture",
  "Software Architecture, Design and Construction",
  "Databases",
  "Software and Data Security",
  "Software Economics",
  "Empirical Software Engineering Methods",
  "Human-Computer Interaction",
  "Software Project Management",
  "Software Modeling and Analysis",
  "Object-Oriented Programming",
  "Operating Systems",
  "Computer Network Organization",
  "Fundamentals of Software Engineering",
  "Programming Fundamentals",
  "Software Engineering Project and Professional Practice",
  "Web Design",
  "Internet Programming",
  "Design Patterns",
  "Linear Programming",
  "Software Quality and Testing",
  "ASP.NET Core",
  "Software Interface Design",
  "Network Application Development",
  "Nonlinear Programming",
  "Discrete Programming",
  "Artificial Intelligence Systems",
  "Software Environments and Packages",
  "Foreign Language for Professional Purposes",
  "PHP Programming",
  "Web Application Interface Design",
  "Mobile Device Programming",
  "Mathematical Methods of Operations Research",
  "Modern Artificial Intelligence",
  "Application Software Packages",
  "Node.js Programming",
  "PHP Backend Frameworks",
  ".NET Development",
  "Dev Net",
]

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
  viewRole: $("#viewRole"),
  viewPosition: $("#viewPosition"),
  viewDept: $("#viewDept"),
  viewSubjects: $("#viewSubjects"),
  viewPhone: $("#viewPhone"),
  viewAbout: $("#viewAbout"),
  viewSocial: $("#viewSocial"),
  emailField: $("#emailField"),
  positionSelect: $("#positionSelect"),
  positionOtherField: $("#positionOtherField"),
  positionOther: $("#positionOther"),
  subjectSearch: $("#subjectSearch"),
  subjectList: $("#subjectList"),
  chipAvatar: $("#chipAvatar"),
  chipName: $("#chipName"),
}

let photoData = null

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

// Побудова випадаючого списку посад
function buildPositions() {
  els.positionSelect.innerHTML =
    '<option value="">—</option>' +
    POSITIONS.map((p) => `<option value="${p}">${p}</option>`).join("")
}

// Показ/приховування поля "Other"
function togglePositionOther() {
  const isOther = els.positionSelect.value === "Other"
  els.positionOtherField.classList.toggle("hidden", !isOther)
}

// Побудова списку предметів (чекбокси)
function buildSubjects(selected = []) {
  els.subjectList.innerHTML = SUBJECTS.map((s, i) => {
    const checked = selected.includes(s) ? "checked" : ""
    return `<label class="subject-item" data-name="${s.toLowerCase()}">
      <input type="checkbox" value="${s}" id="subj-${i}" ${checked} />
      <span>${s}</span>
    </label>`
  }).join("")
}

function getSelectedSubjects() {
  return Array.from(els.subjectList.querySelectorAll("input:checked")).map((i) => i.value)
}

// Фільтр пошуку предметів
els.subjectSearch.addEventListener("input", () => {
  const q = els.subjectSearch.value.trim().toLowerCase()
  els.subjectList.querySelectorAll(".subject-item").forEach((item) => {
    item.style.display = item.dataset.name.includes(q) ? "" : "none"
  })
})

els.positionSelect.addEventListener("change", togglePositionOther)

function renderTags(subjects) {
  if (!subjects || subjects.length === 0) {
    els.viewSubjects.innerHTML = '<span class="tags__empty">—</span>'
    return
  }
  els.viewSubjects.innerHTML = subjects.map((s) => `<span>${s}</span>`).join("")
}

function fillView(user) {
  // Верхня панель: аватар + ім'я
  els.chipAvatar.textContent = (user.full_name || "?").trim().charAt(0).toUpperCase()
  els.chipName.textContent = user.full_name || "—"

  els.viewName.textContent = user.full_name || "—"
  els.viewEmail.textContent = user.email || "—"
  els.viewRole.textContent = user.role || "Faculty"
  els.viewPosition.textContent = user.position || "—"
  els.viewDept.textContent = user.department || "—"
  els.viewPhone.textContent = user.phone || "—"
  els.viewAbout.textContent = user.about || "Add a brief introduction and describe your research interests."
  renderProfileLinks(user)
  els.photoPlaceholder.textContent = (user.full_name || "F").trim().charAt(0).toUpperCase()
  renderTags(user.subjects)

  els.emailField.value = user.email || ""
  els.form.full_name.value = user.full_name || ""
  els.form.phone.value = user.phone || ""
  els.form.about.value = user.about || ""
  els.form.github_url.value = user.github_url || ""
  els.form.linkedin_url.value = user.linkedin_url || ""
  els.form.portfolio_url.value = user.portfolio_url || ""
  els.form.contacts.value = user.contacts || ""
  if (user.department) els.form.department.value = user.department

  // Position: якщо не входить у список — це "Other"
  if (user.position && POSITIONS.includes(user.position) && user.position !== "Other") {
    els.positionSelect.value = user.position
  } else if (user.position) {
    els.positionSelect.value = "Other"
    els.positionOther.value = user.position
  } else {
    els.positionSelect.value = ""
  }
  togglePositionOther()

  buildSubjects(user.subjects || [])
  setPhoto(user.photo)
}

function renderProfileLinks(user) {
  const links = [["GitHub", user.github_url], ["LinkedIn", user.linkedin_url], ["Portfolio", user.portfolio_url]]
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
  buildPositions()
  buildSubjects([])
  try {
    const res = await fetch("/api/me")
    if (!res.ok) {
      window.location.href = "/"
      return
    }
    const data = await res.json()
    if (data.user.role === "Студент") {
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

// Upload photo → base64
els.photoInput.addEventListener("change", (e) => {
  const file = e.target.files[0]
  if (!file) return
  if (file.size > 4 * 1024 * 1024) {
    showAlert("File is too large. Maximum size: 4 MB.")
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    photoData = reader.result
    setPhoto(photoData)
  }
  reader.readAsDataURL(file)
})

// Save
els.form.addEventListener("submit", async (e) => {
  e.preventDefault()

  let position = els.positionSelect.value
  if (position === "Other") {
    position = els.positionOther.value.trim()
    if (!position) {
      showAlert('Enter a job title in the field "Other"')
      return
    }
  }

  const body = {
    full_name: els.form.full_name.value,
    phone: els.form.phone.value,
    position,
    department: els.form.department.value,
    subjects: getSelectedSubjects(),
    contacts: els.form.contacts.value,
    about: els.form.about.value,
    github_url: els.form.github_url.value,
    linkedin_url: els.form.linkedin_url.value,
    portfolio_url: els.form.portfolio_url.value,
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
    if (!res.ok) throw new Error(data.error || "Could not save changes")
    photoData = null
    fillView(data.user)
    showAlert("Profile saved successfully", true)
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
