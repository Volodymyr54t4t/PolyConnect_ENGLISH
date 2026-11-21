(() => {
  const options = {
    available: { label: "Available", icon: "🟢" },
    away: { label: "Away", icon: "🟡" },
    dnd: { label: "Do not disturb", icon: "🔴" },
    offline: { label: "Offline", icon: "⚫" },
  }
  const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char])

  window.presenceMarkup = (status, message = "") => {
    const key = Object.prototype.hasOwnProperty.call(options, status) ? status : "offline"
    const current = options[key]
    return `<span class="presence-inline presence-inline--${key}"><i aria-hidden="true"></i><span>${current.label}</span>${message ? `<small>${escapeHtml(message)}</small>` : ""}</span>`
  }

  function updateHeaderPresence(status) {
    const avatar = document.querySelector(".topbar__user .chip__avatar, .topbar__user .userchip__avatar")
    if (!avatar) return
    const key = Object.prototype.hasOwnProperty.call(options, status) ? status : "offline"
    avatar.classList.remove("presence-user-avatar--available", "presence-user-avatar--away", "presence-user-avatar--dnd", "presence-user-avatar--offline")
    avatar.classList.add(`presence-user-avatar--${key}`)
    avatar.title = `Your status: ${options[key].label}`
    avatar.setAttribute("aria-label", `Your status: ${options[key].label}`)
  }

  let lastInteraction = Date.now()
  const markInteraction = () => { lastInteraction = Date.now() }
  ;["pointerdown", "keydown", "touchstart", "scroll"].forEach((eventName) => window.addEventListener(eventName, markInteraction, { passive: true }))

  async function ping() {
    try {
      const response = await fetch("/api/presence/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: document.visibilityState === "visible" && Date.now() - lastInteraction < 5 * 60_000 }),
      })
      if (response.ok) {
        const data = await response.json()
        updateHeaderPresence(data.presence_status)
      }
    } catch { /* Presence is best-effort while offline or navigating. */ }
  }

  const initialPing = ping()
  window.setInterval(ping, 35_000)
  document.addEventListener("visibilitychange", ping)

  const form = document.querySelector("#presenceForm")
  if (!form) return

  const select = document.querySelector("#presenceSelect")
  const messageInput = document.querySelector("#presenceMessage")
  const feedback = document.querySelector("#presenceFeedback")
  const labels = { available: "Available", away: "Away", dnd: "Do not disturb", offline: "Offline" }

  function showStatus(status, message = "") {
    const validStatus = status in labels ? status : "offline"
    document.querySelector("#presenceTitle").textContent = labels[validStatus]
    document.querySelector("#presenceOrb").className = `presence-orb presence-orb--${validStatus}`
    updateHeaderPresence(validStatus)
    const messageView = document.querySelector("#presenceCurrentMessage")
    messageView.textContent = message || "Others can see your status in chats and the user directory."
    select.value = validStatus
  }

  function loadPresence() { return fetch("/api/presence").then((response) => response.ok ? response.json() : null).then((data) => {
    if (!data) return
    showStatus(data.presence_status, data.status_message)
    messageInput.value = data.status_message || ""
  }).catch(() => {}) }
  initialPing.finally(loadPresence)

  select.addEventListener("change", () => {
    const labelsWithIcons = { available: "🟢 Available", away: "🟡 Away", dnd: "🔴 Do not disturb", offline: "⚫ Offline" }
    feedback.textContent = `New status: ${labelsWithIcons[select.value]}. Click “Update status” to save.`
    feedback.classList.remove("is-error", "is-saved")
  })

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    const button = form.querySelector("button[type=submit]")
    button.disabled = true
    feedback.textContent = "Saving status…"
    feedback.classList.remove("is-error", "is-saved")
    try {
      const response = await fetch("/api/presence", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_status: select.value, status_message: messageInput.value.trim() }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("The status API is not available yet. Restart the server with “npm run dev” and try again.")
        }
        throw new Error(data.error || `Could not save status (HTTP ${response.status})`)
      }
      showStatus(data.presence_status, data.status_message)
      feedback.textContent = "Status updated. Others can see it in chats and the user directory."
      feedback.classList.add("is-saved")
      lastInteraction = Date.now()
    } catch (error) {
      feedback.textContent = error.message
      feedback.classList.add("is-error")
    } finally {
      button.disabled = false
    }
  })
})()
