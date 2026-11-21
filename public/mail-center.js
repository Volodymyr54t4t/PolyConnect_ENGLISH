(() => {
  const $ = (selector) => document.querySelector(selector)
  const state = { users: [], user: null }
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
  const selected = (element) => Array.from(element.selectedOptions).map((option) => Number(option.value)).filter(Number.isInteger)
  function fillPeople() {
    const options = state.users.map((person) => `<option value="${person.id}">${escapeHtml(person.full_name)} · ${escapeHtml(person.role)}${person.group_name ? ` · ${escapeHtml(person.group_name)}` : ""} · ${escapeHtml(person.email)}</option>`).join("")
    for (const id of ["people", "cc", "bcc"]) $(`#${id}`).innerHTML = options
    const groups = [...new Set(state.users.filter((person) => person.role === "Студент" && person.group_name).map((person) => person.group_name))].sort((a, b) => a.localeCompare(b, "uk"))
    $("#groups").innerHTML = groups.length ? groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`).join("") : '<option disabled>Груп ще не додано до профілів</option>'
  }
  function recipientPreview() {
    const roles = Array.from(document.querySelectorAll('input[name="role"]:checked')).map((input) => input.value)
    const groups = Array.from($("#groups").selectedOptions).map((option) => option.value)
    const ids = new Set(selected($("#people")))
    if (roles.includes("all")) state.users.forEach((person) => ids.add(person.id))
    else state.users.forEach((person) => {
      if (roles.includes(person.role) || (person.role === "ДеканФІКТ" && roles.includes("Деканат")) || (person.role === "Студент" && groups.includes(person.group_name))) ids.add(person.id)
    })
    const count = ids.size
    $("#recipientCount").textContent = `${count} ${count === 1 ? "адресат" : count > 1 && count < 5 ? "адресати" : "адресатів"}`
  }
  async function init() {
    try {
      const [meResponse, audienceResponse] = await Promise.all([fetch("/api/me"), fetch("/api/mail/audience")])
      if (!meResponse.ok) { location.href = "/"; return }
      const me = await meResponse.json(); const audience = await audienceResponse.json()
      if (!audienceResponse.ok) throw new Error(audience.error || "Немає доступу до центру пошти")
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
    $("#fileList").innerHTML = files.map((file) => `<span class="mail-file">📎 ${escapeHtml(file.name)} · ${(file.size / 1024 / 1024).toFixed(2)} МБ</span>`).join("")
    $("#attachmentHint").textContent = files.length ? `${files.length} ${files.length === 1 ? "файл" : "файлів"} · ${(total / 1024 / 1024).toFixed(2)} / 8 МБ` : "PDF, документи, зображення · до 8 МБ"
  })
  $("#mailForm").addEventListener("submit", async (event) => {
    event.preventDefault()
    const status = $("#formStatus"), button = $("#sendButton"), files = Array.from($("#attachments").files || [])
    status.textContent = ""; status.removeAttribute("data-kind")
    const totalSize = files.reduce((sum, file) => sum + file.size, 0)
    if (totalSize > 8 * 1024 * 1024) { status.textContent = "Загальний розмір вкладень має бути до 8 МБ."; status.dataset.kind = "error"; return }
    if (!state.user) { status.textContent = "Не вдалося перевірити обліковий запис. Оновіть сторінку."; status.dataset.kind = "error"; return }
    const roles = Array.from(document.querySelectorAll('input[name="role"]:checked')).map((input) => input.value)
    if (roles.includes("all")) roles.splice(roles.indexOf("all"), 1, "Студент", "Викладач", "ДеканФІКТ", "Завідувач Кафедри")
    const attachments = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve({ filename: file.name, content: String(reader.result).split(",")[1], contentType: file.type || "application/octet-stream" }); reader.onerror = reject; reader.readAsDataURL(file)
    })))
    const body = { subject: $("#subject").value.trim(), message: $("#message").value.trim(), roles, groups: Array.from($("#groups").selectedOptions).map((option) => option.value), recipientIds: selected($("#people")), ccIds: selected($("#cc")), bccIds: selected($("#bcc")), urgent: $("#urgent").checked, attachments }
    button.disabled = true; button.querySelector("span").textContent = "Надсилаємо…"
    try {
      const response = await fetch("/api/mail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || "Не вдалося надіслати лист")
      status.textContent = `Готово — лист надіслано ${result.sent} ${result.sent === 1 ? "адресату" : "адресатам"}.`; status.dataset.kind = "success"
      $("#mailForm").reset(); $("#fileList").innerHTML = ""; $("#attachmentHint").textContent = "PDF, документи, зображення · до 8 МБ"; recipientPreview()
    } catch (error) { status.textContent = error.message; status.dataset.kind = "error" }
    finally { button.disabled = false; button.querySelector("span").textContent = "Надіслати лист" }
  })
  init()
})()
