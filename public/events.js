(() => {
  const $ = (selector) => document.querySelector(selector)
  const grid = $("#eventsGrid")
  const editor = $("#eventEditor")
  const detail = $("#eventDetail")
  let user = null
  let events = []
  let filter = "upcoming"
  let activeEvent = null
  let selectedCoverData = ""
  let preserveCover = false
  const managerRoles = ["Розробник", "ДеканФІКТ", "Завідувач Кафедри", "Викладач"]
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]))
  const canManage = (event) => managerRoles.includes(user?.role) && (event?.created_by === user?.id || ["ДеканФІКТ", "Розробник"].includes(user?.role))
  const cssSafeUrl = (value) => encodeURI(value).replace(/["'()\\\n\r]/g, (char) => encodeURIComponent(char))
  const eventDate = (value, options = {}) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", ...options }).format(new Date(value))
  const isPast = (event) => new Date(event.ends_at) < new Date()
  const isRegistrationOpen = (event) => event.status === "published" && !isPast(event) && new Date(event.registration_deadline) > new Date()

  async function request(url, options = {}) {
    const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options })
    const data = await response.json().catch(() => ({}))
      if (!response.ok) { const error = new Error(data.error || `Request failed (HTTP ${response.status})`); error.status = response.status; throw error }
    return data
  }

  function statusText(event) {
    if (event.status === "draft") return "Draft"
    if (event.status === "cancelled") return "Cancelled"
    if (isPast(event)) return "Completed"
    if (!isRegistrationOpen(event)) return "Registration is closed"
    if (event.capacity && event.registered_count >= event.capacity) return "No places available"
    return "Registration is open"
  }

  function coverStyle(event) {
    const url = event.has_local_cover ? `/api/events/${event.id}/cover` : event.cover_image
    return url ? ` style="background-image:linear-gradient(180deg,rgba(5,17,43,.02),rgba(5,17,43,.4)),url(&quot;${escapeHtml(cssSafeUrl(url))}&quot;)"` : ""
  }

  function visibleEvents() {
    const query = $("#eventSearch").value.trim().toLocaleLowerCase("uk")
    return events.filter((event) => {
      const matchingQuery = !query || `${event.title} ${event.summary} ${event.event_type} ${event.location}`.toLocaleLowerCase("uk").includes(query)
      if (!matchingQuery) return false
      if (filter === "attending") return ["registered", "waitlisted"].includes(event.my_status)
      if (filter === "hosted") return event.created_by === user.id || (["ДеканФІКТ", "Розробник"].includes(user.role) && event.status !== "published")
      if (filter === "archive") return isPast(event) || event.status === "cancelled"
      return event.status === "published" && !isPast(event)
    })
  }

  function render() {
    const items = visibleEvents()
    const upcoming = events.filter((event) => event.status === "published" && !isPast(event)).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    $("#eventTotal").textContent = upcoming.length
    $("#eventNext").textContent = upcoming.length ? eventDate(upcoming[0].starts_at) : "Nothing yet"
    if (!items.length) {
      const message = filter === "attending" ? "Events you join will appear here." : filter === "hosted" ? "Events you create will appear here, including drafts." : filter === "archive" ? "Completed events will appear here." : "No events yet. Check back later or create the first event."
      grid.innerHTML = `<div class="event-empty">${escapeHtml(message)}</div>`
      return
    }
    grid.innerHTML = items.map((event) => {
      const date = new Date(event.starts_at)
      const status = event.my_status === "registered" ? "You are registered" : event.my_status === "waitlisted" ? "You are on the waitlist" : statusText(event)
      const spots = event.capacity ? `${Math.max(0, event.capacity - event.registered_count)} of ${event.capacity} spots` : `${event.registered_count} participants`
      const location = event.format === "online" ? "Online" : event.location || (event.format === "hybrid" ? "Hybrid" : "Location to be announced")
      return `<article class="event-card"><div class="event-card__cover"${coverStyle(event)}><span class="event-card__date"><b>${date.toLocaleDateString("en-US", { day: "2-digit" })}</b><small>${date.toLocaleDateString("en-US", { month: "short" }).replace(".", "")}</small></span><span class="event-card__type">${escapeHtml(event.event_type)}</span><span class="event-card__status">${escapeHtml(status)}</span></div><div class="event-card__body"><div class="event-card__meta"><span>◷ ${eventDate(event.starts_at, { timeStyle: "short" })}</span><span>⌖ ${escapeHtml(location)}</span></div><h3>${escapeHtml(event.title)}</h3><p class="event-card__summary">${escapeHtml(event.summary || event.description)}</p><div class="event-card__foot"><span class="event-card__spots"><strong>${escapeHtml(spots)}</strong>${event.waitlist_count ? ` · ${event.waitlist_count} on the waitlist` : ""}</span><button class="event-card__open" data-open-event="${event.id}" type="button">Details <span aria-hidden="true">→</span></button></div></div></article>`
    }).join("")
  }

  function openEditor(event = null) {
    $("#eventForm").reset()
    $("#eventCoverFile").value = ""
    $("#eventCoverMessage").textContent = ""
    selectedCoverData = ""
    preserveCover = Boolean(event?.has_local_cover || event?.cover_image)
    $("#eventFormMessage").textContent = ""
    $("#eventEditorTitle").textContent = event ? "Edit event" : "Create event"
    $("#eventId").value = event?.id || ""
    $("#eventTitle").value = event?.title || ""
    $("#eventSummary").value = event?.summary || ""
    $("#eventType").value = event?.event_type || "Lecture"
    $("#eventFormat").value = event?.format || "offline"
    $("#eventStarts").value = event ? toLocalInput(event.starts_at) : ""
    $("#eventEnds").value = event ? toLocalInput(event.ends_at) : ""
    $("#eventDeadline").value = event?.registration_deadline ? toLocalInput(event.registration_deadline) : ""
    $("#eventCapacity").value = event?.capacity ?? ""
    $("#eventLocation").value = event?.location || ""
    $("#eventCover").value = event?.cover_image || ""
    const coverPreview = event?.has_local_cover ? `/api/events/${event.id}/cover` : (event?.cover_image || "")
    $("#eventCoverPreview").src = coverPreview
    $("#eventCoverPreviewWrap").classList.toggle("hidden", !coverPreview)
    $("#eventMeeting").value = event?.meeting_url || ""
    $("#eventContact").value = event?.contact || ""
    $("#eventDescription").value = event?.description || ""
    editor.classList.remove("hidden")
    document.body.classList.add("modal-open")
    $("#eventTitle").focus()
  }

  function toLocalInput(value) {
    const date = new Date(value)
    const offset = date.getTimezoneOffset() * 60000
    return new Date(date.getTime() - offset).toISOString().slice(0, 16)
  }

  function closeEditor() { editor.classList.add("hidden"); document.body.classList.remove("modal-open") }
  function closeDetail() { detail.classList.add("hidden"); document.body.classList.remove("modal-open"); activeEvent = null }

  function openDetail(event) {
    activeEvent = event
    const coverUrl = event.has_local_cover ? `/api/events/${event.id}/cover` : event.cover_image
    $("#detailCover").style.backgroundImage = coverUrl ? `linear-gradient(180deg,rgba(5,17,43,.02),rgba(5,17,43,.2)),url("${cssSafeUrl(coverUrl)}")` : "linear-gradient(130deg,#173360,#4773d8 58%,#b2c9ff)"
    $("#detailType").textContent = `${event.event_type} · ${event.format === "online" ? "Online" : event.format === "hybrid" ? "Hybrid" : "In person"}`
    $("#detailState").textContent = statusText(event)
    $("#detailTitle").textContent = event.title
    $("#detailSummary").textContent = event.summary || ""
    $("#detailWhen").textContent = `${eventDate(event.starts_at, { timeStyle: "short" })} — ${eventDate(event.ends_at, { timeStyle: "short" })}`
    $("#detailWhere").textContent = event.format === "online" ? "Online" : event.location || "Location to be announced"
    $("#detailCreator").textContent = event.creator_name || "Portal team"
    $("#detailCapacity").textContent = `${event.registered_count} participants${event.capacity ? ` of ${event.capacity}` : " · no limit"}${event.waitlist_count ? ` · ${event.waitlist_count} waitlisted` : ""}`
    $("#detailDescription").textContent = event.description
    const links = []
    if (event.meeting_url && /^https?:\/\//i.test(event.meeting_url)) links.push(`<a href="${escapeHtml(event.meeting_url)}" target="_blank" rel="noopener noreferrer">Join event ↗</a>`)
    if (event.contact) links.push(`<a href="mailto:${escapeHtml(event.contact)}">Organizer contact: ${escapeHtml(event.contact)}</a>`)
    $("#detailLinks").innerHTML = links.join("")
    $("#registrationMessage").textContent = ""
    const canEdit = canManage(event)
    $("#editEventBtn").classList.toggle("hidden", !canEdit)
    $("#deleteEventBtn").classList.toggle("hidden", !canEdit)
    $("#cancelEventBtn").classList.toggle("hidden", !canEdit || event.status !== "published")
    $("#participantsBtn").classList.toggle("hidden", !canEdit)
    const registerButton = $("#registerBtn")
    const activeRegistration = ["registered", "waitlisted"].includes(event.my_status)
    const mayCancel = activeRegistration && event.status !== "draft" && new Date(event.starts_at) > new Date()
    const mayAct = isRegistrationOpen(event) || mayCancel
    registerButton.classList.toggle("hidden", !mayAct)
    registerButton.disabled = !mayAct
    registerButton.textContent = event.my_status === "registered" ? "Cancel registration" : event.my_status === "waitlisted" ? "Leave waitlist" : event.capacity && event.registered_count >= event.capacity ? "Join waitlist" : "Join event"
    if (activeRegistration) $("#registrationMessage").textContent = event.my_status === "waitlisted" ? "You are on the waitlist. If a place opens up, your registration will be confirmed automatically." : "Your place is confirmed. You can cancel your registration here if needed."
    detail.classList.remove("hidden")
    document.body.classList.add("modal-open")
    $("#participantsSection").classList.add("hidden")
  }

  async function saveEvent(status) {
    if (!$("#eventForm").reportValidity()) return
    const starts = new Date($("#eventStarts").value)
    const ends = new Date($("#eventEnds").value)
    const deadline = $("#eventDeadline").value ? new Date($("#eventDeadline").value) : starts
    const message = $("#eventFormMessage")
    if (!Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts) { message.textContent = "Check the dates: the end must be after the start."; return }
    if (deadline > starts) { message.textContent = "The registration deadline must be before the event starts."; return }
    const id = $("#eventId").value
    const payload = {
      title: $("#eventTitle").value,
      summary: $("#eventSummary").value,
      event_type: $("#eventType").value,
      format: $("#eventFormat").value,
      starts_at: starts.toISOString(),
      ends_at: ends.toISOString(),
      registration_deadline: deadline.toISOString(),
      capacity: $("#eventCapacity").value || null,
      location: $("#eventLocation").value,
      cover_image: selectedCoverData || $("#eventCover").value.trim() || (preserveCover ? null : ""),
      meeting_url: $("#eventMeeting").value,
      contact: $("#eventContact").value,
      description: $("#eventDescription").value,
      status,
    }
    try {
      const saved = await request(id ? `/api/events/${id}` : "/api/events", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) })
      closeEditor()
      await load()
      if (status === "published") openDetail(events.find((item) => item.id === saved.event.id) || saved.event)
    } catch (error) { message.textContent = error.message }
  }

  async function loadParticipants() {
    if (!activeEvent) return
    try {
      const data = await request(`/api/events/${activeEvent.id}/participants`)
      const participants = data.participants || []
      $("#participantCount").textContent = `(${participants.filter((item) => item.status === "registered").length} participants · ${participants.filter((item) => item.status === "waitlisted").length} waitlisted)`
      $("#participantList").innerHTML = participants.length ? participants.map((person) => `<div class="event-participants__row"><span>${escapeHtml(person.full_name)} <small>(${escapeHtml(person.role)})</small></span><small>${person.status === "waitlisted" ? "Waitlisted" : "Registered"} · ${escapeHtml(person.email)}</small></div>`).join("") : "<p>No one has registered yet.</p>"
      $("#participantsSection").classList.remove("hidden")
    } catch (error) { $("#registrationMessage").textContent = error.message }
  }

  async function load() {
    try {
      const me = await request("/api/me")
      user = me.user
      $("#navProfile").href = user.redirect || "/profileStudent"
      $("#userName").textContent = user.full_name
      $("#userAvatar").textContent = (user.full_name || "?").trim().charAt(0).toUpperCase()
      const manager = managerRoles.includes(user.role)
      $("#createEventBtn").classList.toggle("hidden", !manager)
      $("#hostedFilter").classList.toggle("hidden", !manager)
      if (["ДеканФІКТ", "Розробник"].includes(user.role)) $("#hostedFilter").textContent = "Management"
      const response = await request("/api/events")
      events = response.events || []
      render()
    } catch (error) {
      if (error.status === 401) { window.location.href = "/"; return }
      grid.innerHTML = `<div class="event-empty">${escapeHtml(error.message)}</div>`
    }
  }

  $("#createEventBtn").addEventListener("click", () => openEditor())
  $("#eventCoverFile").addEventListener("change", (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"]
    if (!allowed.includes(file.type) || file.size > 5 * 1024 * 1024) {
      $("#eventCoverMessage").textContent = "Choose a PNG, JPEG, WebP, or GIF file up to 5 MB."
      event.target.value = ""
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      selectedCoverData = String(reader.result || "")
      preserveCover = false
      $("#eventCover").value = ""
      $("#eventCoverPreview").src = selectedCoverData
      $("#eventCoverPreviewWrap").classList.remove("hidden")
      $("#eventCoverMessage").textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`
    }
    reader.onerror = () => { $("#eventCoverMessage").textContent = "Could not read the file. Please try again." }
    reader.readAsDataURL(file)
  })
  $("#eventCover").addEventListener("input", () => {
    selectedCoverData = ""
    preserveCover = false
    const url = $("#eventCover").value.trim()
    if (/^https?:\/\//i.test(url)) { $("#eventCoverPreview").src = url; $("#eventCoverPreviewWrap").classList.remove("hidden") }
    else $("#eventCoverPreviewWrap").classList.add("hidden")
  })
  $("#clearEventCover").addEventListener("click", () => {
    selectedCoverData = ""
    preserveCover = false
    $("#eventCoverFile").value = ""
    $("#eventCover").value = ""
    $("#eventCoverPreview").removeAttribute("src")
    $("#eventCoverPreviewWrap").classList.add("hidden")
    $("#eventCoverMessage").textContent = "The cover image will be removed after saving."
  })
  $("#saveDraftBtn").addEventListener("click", () => saveEvent("draft"))
  $("#publishEventBtn").addEventListener("click", () => saveEvent("published"))
  $("#eventSearch").addEventListener("input", render)
  document.querySelectorAll("[data-close-editor]").forEach((button) => button.addEventListener("click", closeEditor))
  document.querySelectorAll("[data-close-detail]").forEach((button) => button.addEventListener("click", closeDetail))
  document.querySelectorAll(".event-tab").forEach((button) => button.addEventListener("click", () => { filter = button.dataset.filter; document.querySelectorAll(".event-tab").forEach((tab) => tab.classList.toggle("is-active", tab === button)); render() }))
  grid.addEventListener("click", (event) => { const button = event.target.closest("[data-open-event]"); if (button) { const item = events.find((row) => row.id === Number(button.dataset.openEvent)); if (item) openDetail(item) } })
  $("#registerBtn").addEventListener("click", async () => {
    if (!activeEvent) return
    const canceling = ["registered", "waitlisted"].includes(activeEvent.my_status)
    if (canceling && !await window.modalConfirm("Are you sure you want to cancel your registration? If a place opens, it will be offered to the next person on the waitlist.", { title: "Cancel registration?", danger: true })) return
    const button = $("#registerBtn")
    button.disabled = true
    try {
      const response = await request(`/api/events/${activeEvent.id}/register`, { method: "POST", body: "{}" })
      $("#registrationMessage").textContent = response.message
      await load()
      const updated = events.find((event) => event.id === activeEvent?.id)
      if (updated) openDetail(updated)
      else closeDetail()
    } catch (error) { $("#registrationMessage").textContent = error.message; button.disabled = false }
  })
  $("#editEventBtn").addEventListener("click", () => { const event = activeEvent; closeDetail(); if (event) openEditor(event) })
  $("#deleteEventBtn").addEventListener("click", async () => {
    if (!activeEvent || !await window.modalConfirm("This event and all registrations will be permanently deleted.", { title: "Delete event?", danger: true })) return
    try { await request(`/api/events/${activeEvent.id}`, { method: "DELETE" }); closeDetail(); await load() } catch (error) { $("#registrationMessage").textContent = error.message }
  })
  $("#cancelEventBtn").addEventListener("click", async () => {
    if (!activeEvent || !await window.modalConfirm("Registration will close, and the event will remain in the calendar as cancelled. Participants will see the update.", { title: "Cancel event?", danger: true })) return
    try {
      const result = await request(`/api/events/${activeEvent.id}/cancel`, { method: "POST", body: "{}" })
      const id = activeEvent.id
      await load()
      const updated = events.find((event) => event.id === id)
      if (updated) openDetail(updated)
      $("#registrationMessage").textContent = result.message
    } catch (error) { $("#registrationMessage").textContent = error.message }
  })
  $("#participantsBtn").addEventListener("click", loadParticipants)
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeDetail(); closeEditor() } })
  load()
})()
