const $ = (sel) => document.querySelector(sel)

const els = {
  tabs: document.querySelectorAll(".tab"),
  forms: document.querySelectorAll(".form"),
  alert: $("#alert"),
  authBox: $("#authBox"),
  account: $("#account"),
  loginForm: $("#loginForm"),
  registerForm: $("#registerForm"),
  forgotForm: $("#forgotForm"),
  resetBlock: $("#resetBlock"),
  resetBtn: $("#resetBtn"),
  logoutBtn: $("#logoutBtn"),
  accName: $("#accName"),
  accEmail: $("#accEmail"),
  accRole: $("#accRole"),
  accAvatar: $("#accAvatar"),
  lockoutOverlay: $("#lockoutOverlay"),
  lockoutTimer: $("#lockoutTimer"),
}

let lockoutInterval = null

function showAlert(message, ok = false) {
  if (window.modalAlert) return modalAlert(message)
  els.alert.textContent = message
  els.alert.classList.remove("hidden", "is-ok", "is-err")
  els.alert.classList.add(ok ? "is-ok" : "is-err")
}

function clearAlert() {
  els.alert.classList.add("hidden")
  els.alert.textContent = ""
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || "Something went wrong")
    error.locked = Boolean(data.locked)
    error.retryAfterSeconds = Number(data.retryAfterSeconds) || 600
    error.attemptsRemaining = Number.isInteger(data.attemptsRemaining) ? data.attemptsRemaining : null
    error.challengeLocked = Boolean(data.challengeLocked)
    throw error
  }
  return data
}

function showLockout(seconds) {
  const endsAt = Date.now() + seconds * 1000
  const updateTimer = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000))
    els.lockoutTimer.textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`
    if (remaining === 0) {
      clearInterval(lockoutInterval)
      lockoutInterval = null
      els.lockoutOverlay.classList.add("hidden")
      document.body.classList.remove("is-locked-out")
    }
  }
  clearInterval(lockoutInterval)
  document.body.classList.add("is-locked-out")
  els.lockoutOverlay.classList.remove("hidden")
  updateTimer()
  lockoutInterval = setInterval(updateTimer, 1000)
}

function showAuthError(error) {
  if (error.locked) showLockout(error.retryAfterSeconds)
  else showAlert(error.message)
}

function switchView(view) {
  els.tabs.forEach((tab) => { tab.hidden = false })
  clearAlert()
  els.tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.view === view))
  els.forms.forEach((f) => {
    if (f.dataset.view) f.classList.toggle("hidden", f.dataset.view !== view)
  })
}

function renderAccount(user) {
  els.authBox.classList.add("hidden")
  els.account.classList.remove("hidden")
  els.accName.textContent = user.full_name
  els.accEmail.textContent = user.email
  els.accRole.textContent = user.role
  els.accAvatar.textContent = (user.full_name || "?").trim().charAt(0).toUpperCase()
}

function renderAuth() {
  els.account.classList.add("hidden")
  els.authBox.classList.remove("hidden")
}

async function checkSession() {
  try {
    const res = await fetch("/api/me")
    if (!res.ok) return renderAuth()
    // Уже авторизований → одразу на головну сторінку
    window.location.href = "/home"
  } catch {
    renderAuth()
  }
}

els.tabs.forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)))

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault()
  clearAlert()
  const fd = new FormData(els.loginForm)
  try {
    await api("/api/login", {
      email: fd.get("email"),
      password: fd.get("password"),
    })
    window.location.href = "/home"
  } catch (err) {
    showAuthError(err)
  }
})

els.registerForm.addEventListener("submit", async (e) => {
  e.preventDefault()
  clearAlert()
  const fd = new FormData(els.registerForm)
  try {
    await api("/api/register", {
      full_name: fd.get("full_name"),
      email: fd.get("email"),
      role: fd.get("role"),
      password: fd.get("password"),
    })
    window.location.href = "/home"
  } catch (err) {
    showAuthError(err)
  }
})

els.forgotForm.addEventListener("submit", async (e) => {
  e.preventDefault()
  clearAlert()
  const fd = new FormData(els.forgotForm)
  try {
    const data = await api("/api/forgot-password", {
      email: fd.get("email")
    })
    els.resetBlock.classList.remove("hidden")
    if (data.reset_token) {
      els.forgotForm.querySelector('input[name="token"]').value = data.reset_token
      showAlert("A reset token has been generated below. Enter a new password.", true)
    } else {
      showAlert(data.message, true)
    }
  } catch (err) {
    showAlert(err.message)
  }
})

els.resetBtn.addEventListener("click", async () => {
  clearAlert()
  const fd = new FormData(els.forgotForm)
  try {
    const data = await api("/api/reset-password", {
      token: fd.get("token"),
      password: fd.get("new_password"),
    })
    showAlert(data.message, true)
    els.resetBlock.classList.add("hidden")
    els.forgotForm.reset()
    setTimeout(() => switchView("login"), 1500)
  } catch (err) {
    showAlert(err.message)
  }
})

els.logoutBtn.addEventListener("click", async () => {
  try {
    await api("/api/logout", {})
  } catch {
    /* ignore */
  }
  renderAuth()
  switchView("login")
})

// Посилання з адмінки веде напряму до встановлення пароля нового акаунта.
const setupToken = new URLSearchParams(location.search).get("token")
if (setupToken) {
  switchView("forgot")
  els.resetBlock.classList.remove("hidden")
  els.forgotForm.querySelector('input[name="token"]').value = setupToken
  els.forgotForm.querySelector('input[name="email"]').closest("label").classList.add("hidden")
  els.forgotForm.querySelector('button[type="submit"]').classList.add("hidden")
  showAlert("Create a password for your account, then complete your profile.", true)
} else {
  checkSession()
}
