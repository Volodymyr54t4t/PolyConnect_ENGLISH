(() => {
  const nav = document.querySelector('.topbar__nav')
  if (!nav) return

  const currentPath = location.pathname
  const isHome = currentPath === '/home' || currentPath === '/'
  let noticeTimer
  const links = [
    ['/home', 'Home'], ['/news', 'News'], ['/events', 'Events'],
    ['/polls', 'Polls'], ['/chats', 'Chats'], ['/ideas', 'Ideas'],
    ['/achievements', 'Achievements'], ['/students', 'Students'],
  ]
  const categories = [
    { title: 'Portal', items: links.slice(0, 4) },
    { title: 'Community', items: links.slice(4, 6) },
    { title: 'People', items: links.slice(6) },
  ]

  function render(role) {
    const staff = ['Розробник', 'ДеканФІКТ', 'Завідувач Кафедри', 'Викладач'].includes(role)
    const profilePath = role === 'Студент' ? '/profileStudent' : '/profileTeacher'
    const admin = role === 'Розробник'
      ? ['/admin', 'Admin panel']
      : role === 'ДеканФІКТ' ? ['/dean-dashboard', 'Dashboard']
        : role === 'Завідувач Кафедри' ? ['/profiles-review', 'Department profiles'] : null
    const groups = categories.map(group => ({ ...group, items: [...group.items] }))
    if (staff) groups[1].items.push(['/mail-center', 'Mail', isHome ? 'mailCenterLink' : undefined])
    if (admin) groups.push({ title: 'Management', items: [[...admin, isHome ? 'deanDashboardLink' : currentPath === '/polls' ? 'deanLink' : currentPath === '/dean-dashboard' ? 'adminHomeLink' : undefined]] })
    if (role === 'Розробник') groups[3].items.push(['/profiles-review', 'Профілі кафедри'])
    const profileHref = isHome ? '#profile' : profilePath
    const activePath = currentPath === '/profileStudent' || currentPath === '/profileTeacher' ? 'profile' : currentPath
    nav.innerHTML = groups.map(group => {
      const active = group.items.some(([href]) => activePath === href || (href === '/home' && isHome))
      return `<details class="navgroup"${active ? ' data-active="true"' : ''}><summary class="navgroup__trigger">${group.title}<span aria-hidden="true"></span></summary><div class="navgroup__menu">${group.items.map(([href, label, id]) => `<a href="${href === '/home' && isHome ? '#dashboard' : href}" class="navlink${(activePath === href || (href === '/home' && isHome)) ? ' is-active' : ''}"${id ? ` id="${id}"` : ''}>${label}</a>`).join('')}</div></details>`
    }).join('') + `<a href="${profileHref}" class="navlink navlink--profile${activePath === 'profile' ? ' is-active' : ''}" id="navProfile">Profile</a>`

    addProfileDisclosure(role, profileHref)
    bindSingleOpenRule()
    if (currentPath === '/ideas') document.querySelector('.user-link')?.remove()
  }

  function bindSingleOpenRule() {
    const topbar = nav.closest('.topbar')
    if (!topbar || topbar.dataset.singleMenuBound) return
    topbar.dataset.singleMenuBound = 'true'
    const notice = document.createElement('div')
    notice.className = 'header-menu-notice'
    notice.setAttribute('role', 'status')
    notice.setAttribute('aria-live', 'polite')
    notice.textContent = 'Close the previously opened menu'
    topbar.append(notice)

    topbar.addEventListener('click', event => {
      const summary = event.target.closest('summary')
      const targetMenu = summary?.parentElement
      if (!targetMenu || !targetMenu.matches('.navgroup, .profile-disclosure') || targetMenu.open) return
      const openMenu = topbar.querySelector('details.navgroup[open], details.profile-disclosure[open]')
      if (!openMenu || openMenu === targetMenu) return
      event.preventDefault()
      event.stopPropagation()
      notice.classList.add('is-visible')
      clearTimeout(noticeTimer)
      noticeTimer = setTimeout(() => notice.classList.remove('is-visible'), 2600)
    }, true)
  }

  function addProfileDisclosure(role, profileHref) {
    const user = document.querySelector('.topbar__user')
    const chip = user?.querySelector('.chip')
    if (!user || !chip || user.querySelector('.profile-disclosure')) return
    const wrap = document.createElement('details')
    wrap.className = 'profile-disclosure'
    wrap.innerHTML = `<summary class="profile-disclosure__trigger" aria-label="More profile information"><span aria-hidden="true"></span></summary><div class="profile-disclosure__panel"><span class="profile-disclosure__eyebrow">YOUR PROFILE</span><strong data-profile-fullname>User</strong><span class="profile-disclosure__role"></span><a href="${profileHref}">Open profile <span aria-hidden="true">↗</span></a></div>`
    const roleLabels = { 'ДеканФІКТ': 'Faculty Dean', 'Завідувач Кафедри': 'Department Chair', 'Викладач': 'Faculty', 'Студент': 'Student', 'Розробник': 'Developer' }
    wrap.querySelector('.profile-disclosure__role').textContent = roleLabels[role] || 'PolyConnect member'
    user.append(wrap)
    const syncName = () => {
      const name = user.querySelector('.chip__name, .userchip__name')?.textContent?.trim()
      if (name) wrap.querySelector('[data-profile-fullname]').textContent = name
    }
    syncName()
    new MutationObserver(syncName).observe(chip, { childList: true, subtree: true, characterData: true })
    document.addEventListener('click', event => { if (!wrap.contains(event.target)) wrap.open = false })
  }

  fetch('/api/me', { credentials: 'same-origin' })
    .then(response => response.ok ? response.json() : null)
    .then(data => render(data?.user?.role || ''))
    .catch(() => render(''))
})()
