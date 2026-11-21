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
      confirmation.value.trim().toUpperCase() === "DELETE"
    )
  }

  form.addEventListener("input", validate)
  fetch("/api/me")
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Could not verify the account. Refresh the page.")))
    .then(({ user }) => {
      accountEmail = String(user?.email || "").trim().toLowerCase()
      emailHint.textContent = accountEmail ? `(your email: ${accountEmail})` : ""
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
    feedback.textContent = "Verifying details and deleting your account…"
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
      if (!response.ok) throw new Error(data.error || `Could not delete the account (HTTP ${response.status})`)
      feedback.textContent = "Account deleted. Redirecting…"
      feedback.classList.add("is-saved")
      window.setTimeout(() => { window.location.replace("/") }, 900)
    } catch (error) {
      feedback.textContent = error.message
      feedback.classList.add("is-error")
      validate()
    }
  })
})()
