(() => {
  const form = document.querySelector("#deleteAccountForm")
  if (!form) return

  const password = form.elements.password
  const email = form.elements.email
  const confirmation = form.elements.confirmation
  const button = form.querySelector("button[type=submit]")
  const feedback = document.querySelector("#deleteAccountFeedback")
  const emailHint = document.querySelector("#deleteAccountEmailHint")
  let accountEmail = ""

  function validate() {
    button.disabled = !(
      password.value.length > 0 &&
      accountEmail && email.value.trim().toLowerCase() === accountEmail &&
      confirmation.value.trim() === "ВИДАЛИТИ"
    )
  }

  form.addEventListener("input", validate)
  fetch("/api/me")
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Не вдалося перевірити акаунт. Оновіть сторінку.")))
    .then(({ user }) => {
      accountEmail = String(user?.email || "").trim().toLowerCase()
      emailHint.textContent = accountEmail ? `(ваш email: ${accountEmail})` : ""
      validate()
    })
    .catch((error) => {
      feedback.textContent = error.message
      feedback.classList.add("is-error")
    })

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    validate()
    if (button.disabled) return
    button.disabled = true
    feedback.textContent = "Перевіряємо дані та видаляємо акаунт…"
    feedback.classList.remove("is-error", "is-saved")
    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: password.value,
          email: email.value.trim(),
          confirmation: confirmation.value.trim(),
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || `Не вдалося видалити акаунт (HTTP ${response.status})`)
      feedback.textContent = "Акаунт видалено. Перенаправляємо…"
      feedback.classList.add("is-saved")
      window.setTimeout(() => { window.location.replace("/") }, 900)
    } catch (error) {
      feedback.textContent = error.message
      feedback.classList.add("is-error")
      validate()
    }
  })
})()
