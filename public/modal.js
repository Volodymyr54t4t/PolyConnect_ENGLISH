const appModalState = { resolve: null }

function closeAppModal(result = true) {
  const modal = document.querySelector('#appModal')
  if (!modal) return
  modal.classList.add('hidden')
  document.body.classList.remove('modal-open')
  if (appModalState.resolve) {
    const resolve = appModalState.resolve
    appModalState.resolve = null
    resolve(result)
  }
}

function showAppModal({ title, message, confirm = false, danger = false }) {
  let modal = document.querySelector('#appModal')
  if (!modal) {
    modal = document.createElement('div')
    modal.id = 'appModal'
    modal.className = 'app-modal hidden'
    modal.innerHTML = `<div class="app-modal__backdrop" data-modal-close></div><section class="app-modal__panel" role="dialog" aria-modal="true" aria-labelledby="appModalTitle"><div class="app-modal__brand"><span class="app-modal__brand-name">Zhytomyr<br>Polytechnic</span></div><div class="app-modal__body"><h2 id="appModalTitle" class="app-modal__title"></h2><p id="appModalMessage" class="app-modal__message"></p><div class="app-modal__actions"><button type="button" class="app-modal__button" id="appModalCancel">Cancel</button><button type="button" class="app-modal__button app-modal__button--primary" id="appModalConfirm">OK</button></div></div></section>`
    document.body.appendChild(modal)
    modal.querySelector('[data-modal-close]').addEventListener('click', () => closeAppModal(false))
    modal.querySelector('#appModalCancel').addEventListener('click', () => closeAppModal(false))
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeAppModal(false) })
  }
  modal.querySelector('#appModalTitle').textContent = title
  modal.querySelector('#appModalMessage').textContent = message
  modal.querySelector('#appModalCancel').classList.toggle('hidden', !confirm)
  const confirmButton = modal.querySelector('#appModalConfirm')
  confirmButton.textContent = confirm ? 'Confirm' : 'OK'
  confirmButton.classList.toggle('app-modal__button--danger', danger)
  confirmButton.onclick = () => closeAppModal(true)
  modal.classList.remove('hidden')
  document.body.classList.add('modal-open')
  confirmButton.focus()
  return new Promise(resolve => { appModalState.resolve = resolve })
}

window.modalAlert = (message, options = {}) => showAppModal({ title: options.title || 'Message', message })
window.modalConfirm = (message, options = {}) => showAppModal({ title: options.title || 'Proof', message, confirm: true, danger: Boolean(options.danger) })
