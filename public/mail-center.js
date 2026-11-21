(() => {
  const $ = (selector) => document.querySelector(selector)
  const state = { users: [], user: null }
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
  const selected = (element) => Array.from(element.selectedOptions).map((option) => Number(option.value)).filter(Number.isInteger)
  function fillPeople() {
    const options = state.users.map((person) => `<option value="${person.id}">${escapeHtml(person.full_name)} · ${escapeHtml(person.role)}${person.group_name ? ` · ${escapeHtml(person.group_name)}` : ""} · ${escapeHtml(person.email)}</option>`).join("")
    for (const id of ["people", "cc", "bcc"]) $(`#${id}`).innerHTML = options
    const groups = [...new Set(state.users.filter((person) => person.role === "Студент" && person.group_name).map((person) => person.group_name))].sort((a, b) => a.localeCompare(b, "en"))
    $("#groups").innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("") : '<option disabled>No groups have been added to profiles yet</option>'
  }
  function recipientPreview() {
    const roles = Array.from(document.querySelectorAll('input[name="role"]:checked')).map((input) => input.value)
    const groups = Array.from($("#groups").selectedOptions).map((option) => option.value)
    const ids = new Set(selected($("#people")))
    if (roles.includes("all")) state.users.forEach((person) => ids.add(person.id))
    else state.users.forEach((person) => {
      if (roles.includes(person.role) || (person.role === "ДеканФІКТ" && roles.includes("Dean’s office")) || (person.role === "Студент" && groups.includes(person.group_name))) ids.add(person.id)
    })
    const count = ids.size
    $("#recipientCount").textContent = `${count} ${count === 1 ? "recipient" : count > 1 && count < 5 ? "recipients" : "recipients"}`
  }
  async function init() {
    try {
      const [meResponse, audienceResponse] = await Promise.all([fetch("/api/me"), fetch("/api/mail/audience")])
      if (!meResponse.ok) { location.href = "/"; return }
      const me = await meResponse.json(); const audience = await audienceResponse.json()
      if (!audienceResponse.ok) throw new Error(audience.error || "You do not have access to the mail center")
      state.user = me.user; state.users = audience.users || []
      $("#userName").textContent = state.user.full_name; $("#userAvatar").textContent = (state.user.full_name || "?").trim().charAt(0)
      $("#navProfile").href = state.user.redirect || (state.user.role === "Викладач" ? "/profileTeacher" : "/profileStudent")
      fillPeople(); recipientPreview()
    } catch (error) { $("#formStatus").textContent = error.message; $("#formStatus").dataset.kind = "error" }
  }
  document.querySelectorAll('input[name="role"]').forEach((input) => input.addEventListener("change", () => {
    if (input.value === "all" && input.checked) document.querySelectorAll('input[name="role"]:not([value="all"])').forEach((other) => { other.checked = false })
    if (input.value !== "all" && input.checked) $('input[name="role"][value="all"]').checked = false
    recipientPreview()
  }))
  for (const selector of ["#groups", "#people"]) $(selector).addEventListener("change", recipientPreview)
  $("#attachments").addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []), total = files.reduce((sum, file) => sum + file.size, 0)
    $("#fileList").innerHTML = files.map((file) => `<span class="mail-file">📎 ${escapeHtml(file.name)} · ${(file.size / 1024 / 1024).toFixed(2)} MB</span>`).join("")
    $("#attachmentHint").textContent = files.length ? `${files.length} ${files.length === 1 ? "file" : "files"} · ${(total / 1024 / 1024).toFixed(2)} / 8 MB` : "PDF, documents, images · up to 8 MB"
  })
  $("#mailForm").addEventListener("submit", async (event) => {
    event.preventDefault()
    const status = $("#formStatus"), button = $("#sendButton"), files = Array.from($("#attachments").files || [])
    status.textContent = ""; status.removeAttribute("data-kind")
    const totalSize = files.reduce((sum, file) => sum + file.size, 0)
    if (totalSize > 8 * 1024 * 1024) { status.textContent = "Attachments must total no more than 8 MB."; status.dataset.kind = "error"; return }
    if (!state.user) { status.textContent = "Could not verify your account. Refresh the page."; status.dataset.kind = "error"; return }
    const roles = Array.from(document.querySelectorAll('input[name="role"]:checked')).map((input) => input.value)
    if (roles.includes("all")) roles.splice(roles.indexOf("all"), 1, "Студент", "Викладач", "ДеканФІКТ", "Завідувач Кафедри")
    const attachments = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve({ filename: file.name, content: String(reader.result).split(",")[1], contentType: file.type || "application/octet-stream" }); reader.onerror = reject; reader.readAsDataURL(file)
    })))
    const body = { subject: $("#subject").value.trim(), message: $("#message").value.trim(), roles, groups: Array.from($("#groups").selectedOptions).map((option) => option.value), recipientIds: selected($("#people")), ccIds: selected($("#cc")), bccIds: selected($("#bcc")), urgent: $("#urgent").checked, attachments }
    button.disabled = true; button.querySelector("span").textContent = "Sending…"
    try {
      const response = await fetch("/api/mail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || "Could not send email")
      status.textContent = `Done — email sent to ${result.sent} ${result.sent === 1 ? "recipient" : "recipients"}.`; status.dataset.kind = "success"
      $("#mailForm").reset(); $("#fileList").innerHTML = ""; $("#attachmentHint").textContent = "PDF, documents, images · up to 8 MB"; recipientPreview()
    } catch (error) { status.textContent = error.message; status.dataset.kind = "error" }
    finally { button.disabled = false; button.querySelector("span").textContent = "Send email" }
  })
  init()
})()
