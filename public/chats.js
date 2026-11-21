const $ = (s) => document.querySelector(s)
const state = { chats: [], current: null, messages: [], messagesHasMore: false, olderMessagesLoading: false, user: null, users: [], selectedUser: null, userRoleFilter: 'All', selectedFiles: [], selectedGroupUsers: new Set(), topicsByChat: {}, canManageTopicsByChat: {}, topicByChat: {}, recorder: null, voiceChunks: [], voiceBlob: null, voiceTimer: null, voiceStartedAt: 0, voiceCancelled: false, voicePreviewUrl: null, draftTimer: null }

async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {})
        }
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Something went wrong')
    return data
}

function showError(message) { $('#dialogAlert').textContent = message }

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[char]))
}

function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 54), 180)}px`
}

function formatChatTime(value) {
    if (!value) return ''
    const date = new Date(value)
    const now = new Date()
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }
    return date.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit' })
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function messageFiles(message) {
    if (Array.isArray(message.attachments) && message.attachments.length) return message.attachments
    return message.file_name ? [{ name: message.file_name, type: message.file_type || 'application/octet-stream', index: 0 }] : []
}

function renderMessageFiles(message) {
    return messageFiles(message).map((file, index) => {
        const fileIndex = file.index ?? index
        const url = `/api/chats/${state.current.id}/messages/${message.id}/file?index=${fileIndex}`
        const isAudio = file.name?.startsWith('voice-') && file.type?.startsWith('audio/')
        if (isAudio) return `<div class="message-voice-card"><audio controls preload="metadata" src="${url}"></audio><a href="${url}" target="_blank" rel="noopener">Open audio</a></div>`
        return `<a class="message-attachment" href="${url}" target="_blank" rel="noopener"><span class="message-attachment__icon">📄</span><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.type || 'File')} · Open</small></span></a>`
    }).join('')
}

function renderChats() {
    const box = $('#chatList')
    $('#chatCount').textContent = state.chats.length
    const query = ($('#chatSearch')?.value || '').trim().toLocaleLowerCase('uk')
    const visibleChats = state.chats.filter(chat => `${chat.full_name || ''} ${chat.last_message || ''} ${chat.role || ''}`.toLocaleLowerCase('uk').includes(query))
    if (!visibleChats.length) {
        box.innerHTML = `<p class="empty">${state.chats.length ? 'No chats match your search.' : 'You have no chats yet.'}</p>`
        return
    }

    const sortedChats = [...visibleChats].sort((first, second) => {
        const firstTime = new Date(first.last_message_at || first.created_at).getTime()
        const secondTime = new Date(second.last_message_at || second.created_at).getTime()
        return secondTime - firstTime
    })

    box.innerHTML = sortedChats.map(chat => `
        <button class="chat-item ${state.current?.id === chat.id ? 'is-active' : ''}" data-chat-id="${chat.id}">
            <span class="chat-avatar">${chat.avatar ? `<img src="${chat.avatar}" alt="" />` : (chat.full_name || '?')[0].toUpperCase()}</span>
            <span class="chat-item__content">
                <span class="chat-item__top">
                    <strong>${escapeHtml(chat.full_name)}</strong>
                </span>
                ${chat.chat_type === 'direct' ? `<span class="chat-item__presence">${window.presenceMarkup?.(chat.presence_status, chat.status_message) || ''}</span>` : ''}
                <small><span class="chat-preview">${escapeHtml(chat.last_message || (chat.chat_type === 'group' ? 'Group chat' : chat.role || 'New chat'))}</span><time class="chat-item__time">${formatChatTime(chat.last_message_at || chat.created_at)}</time></small>
                ${chat.unread_count ? `<b class="unread-badge">${chat.unread_count > 99 ? '99+' : chat.unread_count}</b>` : ''}
            </span>
        </button>
    `).join('')

    box.querySelectorAll('[data-chat-id]').forEach(button => {
        button.addEventListener('click', () => openChat(Number(button.dataset.chatId)))
    })
}

function renderMessageHistory(messages, unreadMessageIds = []) {
    const box = $('#messages')
    const unreadIds = new Set(unreadMessageIds)
    let unreadDividerShown = false
    box.innerHTML = messages.length ? messages.map(message => {
        const isUnread = unreadIds.has(message.id)
        const divider = isUnread && !unreadDividerShown ? '<div class="unread-divider"><span>Unread messages</span></div>' : ''
        unreadDividerShown = unreadDividerShown || isUnread
        return `${divider}<div class="message ${message.sender_id === state.user.id ? 'mine' : ''} ${isUnread ? 'is-unread' : ''}" data-message-id="${message.id}">
            <span class="message__content">${escapeHtml(message.content)}</span>${renderMessageFiles(message)}
            <small>${escapeHtml(message.full_name)}${message.edited_at ? ' · edited' : ''}</small>
            <div class="message-actions">${message.sender_id === state.user.id ? `<button type="button" data-edit-message="${message.id}">Edit</button><button type="button" data-delete-message="${message.id}">Delete</button>` : ''}${(state.current?.chat_type !== 'group' || state.current?.is_group_admin || state.user?.role === 'Розробник') ? `<button type="button" data-pin-message="${message.id}" data-pinned="${Boolean(message.is_pinned)}">${message.is_pinned ? 'Unpin' : 'Pin'}</button>` : ''}</div>
        </div>`
    }).join('') : '<p class="empty">No messages yet.</p>'
    $('#loadOlderMessages').classList.toggle('hidden', !state.messagesHasMore)
    const pinned = [...messages].reverse().find(message => message.is_pinned)
    $('#pinnedBanner').classList.toggle('hidden', !pinned)
    $('#pinnedBanner').dataset.messageId = pinned?.id || ''
    $('#pinnedBannerText').textContent = pinned ? (pinned.content || messageFiles(pinned)[0]?.name || 'Attachment') : ''
}

async function loadOlderMessages() {
    if (!state.current || !state.messagesHasMore || state.olderMessagesLoading || !state.messages.length) return
    state.olderMessagesLoading = true
    const button = $('#loadOlderMessages')
    const oldScrollHeight = $('#messages').scrollHeight
    const oldScrollTop = $('#messages').scrollTop
    button.disabled = true
    button.textContent = 'Loading…'
    try {
        const chatId = state.current.id
        const params = new URLSearchParams({ limit: '60', before_id: String(state.messages[0].id) })
        const topicId = state.current.chat_type === 'group' ? state.topicByChat[chatId] : null
        if (topicId) params.set('topic_id', topicId)
        const data = await api(`/api/chats/${chatId}/messages?${params}`)
        if (state.current?.id !== chatId) return
        state.messages = [...data.messages, ...state.messages]
        state.messagesHasMore = Boolean(data.has_more)
        renderMessageHistory(state.messages)
        const box = $('#messages')
        box.scrollTop = oldScrollTop + (box.scrollHeight - oldScrollHeight)
    } catch (error) {
        modalAlert(error.message)
    } finally {
        state.olderMessagesLoading = false
        button.disabled = false
        button.textContent = 'Load older messages'
        button.classList.toggle('hidden', !state.messagesHasMore)
    }
}

async function loadChats() {
    const data = await api('/api/chats')
    state.chats = data.chats
    renderChats()
}

async function openChat(id, { silent = false } = {}) {
    const chat = state.chats.find(item => item.id === id)
    if (!chat) return

    const isSwitchingChat = state.current?.id !== id
    if (isSwitchingChat && state.current) {
        clearTimeout(state.draftTimer)
        await saveChatDraft(state.current.id, $('#messageInput').value)
    }

    state.current = chat
    if (isSwitchingChat) {
        $('#messageInput').value = ''
        state.messages = []
        state.messagesHasMore = false
    }
    $('#chatTitle').textContent = chat.full_name
    $('#chatRole').textContent = chat.chat_type === 'group' ? 'Group · chat members' : (chat.presence_status === 'available' ? 'Online' : (chat.role || 'Direct message'))
    const avatar = $('#conversationAvatar')
    avatar.innerHTML = chat.avatar ? `<img src="${escapeHtml(chat.avatar)}" alt="" />` : `<span>${escapeHtml((chat.full_name || '?').trim().charAt(0).toUpperCase())}</span>`
    avatar.classList.toggle('is-group', chat.chat_type === 'group')
    $('#groupInfoBtn').classList.toggle('hidden', chat.chat_type !== 'group')
    $('#groupInfoBtn').setAttribute('aria-expanded', 'false')
    $('#groupTopicControls').classList.toggle('hidden', chat.chat_type !== 'group')
    $('#createTopicBtn').classList.add('hidden')
    if (chat.chat_type === 'group' && (isSwitchingChat || !Array.isArray(state.topicsByChat[id]))) {
        try {
            const topicData = await api(`/api/groups/${id}/topics`)
            if (state.current?.id !== id) return
            state.topicsByChat[id] = topicData.topics || []
            state.canManageTopicsByChat[id] = Boolean(topicData.can_manage)
            $('#createTopicBtn').classList.toggle('hidden', !state.canManageTopicsByChat[id])
            const selectedTopicId = state.topicByChat[id] || ''
            $('#groupTopicSelect').innerHTML = `<option value="">All topics</option>${state.topicsByChat[id].map(topic => `<option value="${topic.id}">${escapeHtml(topic.name)}</option>`).join('')}`
            $('#groupTopicSelect').value = selectedTopicId
        } catch { state.topicsByChat[id] ||= [] }
    }
    if (chat.chat_type === 'group' && Array.isArray(state.topicsByChat[id])) {
        $('#createTopicBtn').classList.toggle('hidden', !state.canManageTopicsByChat[id])
        if ($('#groupTopicSelect').options.length) $('#groupTopicSelect').value = state.topicByChat[id] || ''
    }
    if (chat.chat_type !== 'group') $('#createTopicBtn').classList.add('hidden')
    $('#chatsLayout').classList.add('has-current-chat')
    $('#messageForm').classList.remove('hidden')
    renderChats()

    const activeTopicId = chat.chat_type === 'group' ? (state.topicByChat[id] || '') : ''
    const messageParams = new URLSearchParams()
    messageParams.set('limit', '60')
    if (activeTopicId) messageParams.set('topic_id', activeTopicId)
    if (silent) messageParams.set('silent', '1')
    const topicQuery = messageParams.size ? `?${messageParams}` : ''
    const requests = [api(`/api/chats/${id}/messages${topicQuery}`)]
    if (isSwitchingChat) requests.push(api(`/api/chats/${id}/draft`).catch(() => ({ draft: { content: '' } })))
    const [data, draftData] = await Promise.all(requests)
    if (state.current?.id !== id) return
    if (isSwitchingChat) {
        $('#messageInput').value = draftData?.draft?.content || ''
        $('#draftStatus').textContent = draftData?.draft?.content ? 'Draft synced' : ''
        autoResizeTextarea($('#messageInput'))
    }
    const box = $('#messages')
    const shouldStayAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90
    const alreadyLoadedOlder = silent && state.messages.length > 60
    let historyChanged = !silent || !state.messages.length
    if (silent && state.messages.length) {
        const combined = new Map(state.messages.map(message => [message.id, message]))
        data.messages.forEach(message => {
            const existing = combined.get(message.id)
            if (!existing || existing.content !== message.content || existing.edited_at !== message.edited_at || existing.is_pinned !== message.is_pinned) historyChanged = true
            combined.set(message.id, message)
        })
        state.messages = [...combined.values()].sort((a, b) => a.id - b.id)
        if (!alreadyLoadedOlder) state.messagesHasMore = Boolean(data.has_more)
    } else {
        state.messages = data.messages
        state.messagesHasMore = Boolean(data.has_more)
    }
    if (historyChanged) renderMessageHistory(state.messages, data.unread_message_ids || [])

    chat.unread_count = 0
    renderChats()
    if (shouldStayAtBottom) box.scrollTop = box.scrollHeight
}

$('#loadOlderMessages').addEventListener('click', loadOlderMessages)

$('#chatSearch').addEventListener('input', renderChats)
$('#backToChatsBtn').addEventListener('click', () => $('#chatsLayout').classList.remove('has-current-chat'))
$('#groupTopicSelect').addEventListener('change', () => {
    if (!state.current || state.current.chat_type !== 'group') return
    state.topicByChat[state.current.id] = $('#groupTopicSelect').value
    openChat(state.current.id)
})
$('#createTopicBtn').addEventListener('click', async () => {
    if (!state.current || state.current.chat_type !== 'group') return
    const chatId = state.current.id
    const name = window.prompt('New topic name')?.trim()
    if (!name) return
    try {
        const result = await api(`/api/groups/${chatId}/topics`, { method: 'POST', body: JSON.stringify({ name }) })
        state.topicsByChat[chatId] = [...(state.topicsByChat[chatId] || []).filter(topic => topic.id !== result.topic.id), result.topic]
        state.topicByChat[chatId] = String(result.topic.id)
        if (state.current?.id === chatId) await openChat(chatId)
    } catch (error) { modalAlert(error.message) }
})

async function saveChatDraft(chatId, content) {
    if (!chatId) return
    try {
        if (content) await api(`/api/chats/${chatId}/draft`, { method: 'PUT', body: JSON.stringify({ content }) })
        else await api(`/api/chats/${chatId}/draft`, { method: 'DELETE' })
        if (state.current?.id === chatId) $('#draftStatus').textContent = content ? 'Draft synced' : ''
    } catch { /* Keep typing available while offline. */ }
}

function queueChatDraftSave() {
    if (!state.current) return
    clearTimeout(state.draftTimer)
    const chatId = state.current.id
    const content = $('#messageInput').value
    state.draftTimer = setTimeout(() => saveChatDraft(chatId, content), 450)
}

$('#pinnedBanner').addEventListener('click', () => {
    const pinnedMessage = document.querySelector(`[data-message-id="${$('#pinnedBanner').dataset.messageId}"]`)
    pinnedMessage?.scrollIntoView({ behavior: 'smooth', block: 'center' })
})

async function editMessage(messageId) {
    const message = document.querySelector(`[data-message-id="${messageId}"]`)
    if (!message || message.querySelector('.message-edit')) return
    const content = message.querySelector('.message__content').textContent
    const editor = document.createElement('div')
    editor.className = 'message-edit'
    editor.innerHTML = `<textarea maxlength="2000">${escapeHtml(content)}</textarea><div><button type="button" data-cancel-edit>Cancel</button><button type="button" class="message-edit__save" data-save-edit>Save</button></div>`
    message.querySelector('.message__content').replaceWith(editor)
    const textarea = editor.querySelector('textarea')
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    editor.querySelector('[data-cancel-edit]').addEventListener('click', () => openChat(state.current.id))
    editor.querySelector('[data-save-edit]').addEventListener('click', async () => {
        const nextContent = textarea.value.trim()
        if (!nextContent) return
        try {
            await api(`/api/chats/${state.current.id}/messages/${messageId}`, { method: 'PUT', body: JSON.stringify({ content: nextContent }) })
            await openChat(state.current.id)
        } catch (error) {
            modalAlert(error.message)
        }
    })
}

async function deleteMessage(messageId) {
    if (!await modalConfirm('Delete this message?', { title: 'Delete message', danger: true })) return
    try {
        await api(`/api/chats/${state.current.id}/messages/${messageId}`, { method: 'DELETE' })
        await loadChats()
        await openChat(state.current.id)
    } catch (error) {
        modalAlert(error.message)
    }
}

$('#messages').addEventListener('click', event => {
    const editButton = event.target.closest('[data-edit-message]')
    const deleteButton = event.target.closest('[data-delete-message]')
    const pinButton = event.target.closest('[data-pin-message]')
    if (editButton) editMessage(Number(editButton.dataset.editMessage))
    if (deleteButton) deleteMessage(Number(deleteButton.dataset.deleteMessage))
    if (pinButton) togglePinnedMessage(pinButton)
})

async function togglePinnedMessage(button) {
    const messageId = Number(button.dataset.pinMessage)
    const willPin = button.dataset.pinned !== 'true'
    try {
        await api(`/api/chats/${state.current.id}/messages/${messageId}/pin`, {
            method: 'PUT', body: JSON.stringify({ is_pinned: willPin })
        })
        await openChat(state.current.id)
    } catch (error) {
        modalAlert(error.message)
    }
}

async function loadUsers() {
    const data = await api('/api/chat-users')
    state.users = data.users
    renderUsers()
    renderGroupUsers()
}

function renderGroupUsers() {
    const sections = {
        'Dean’s office': state.users.filter(user => userGroup(user.role) === 'Dean’s office'),
        'Faculty': state.users.filter(user => userGroup(user.role) === 'Викладач'),
        'Students': state.users.filter(user => userGroup(user.role) === 'Students'),
    }
    const renderOption = user => `<label class="group-user-option"><input type="checkbox" value="${user.id}" ${state.selectedGroupUsers.has(user.id) ? 'checked' : ''}><span class="user-option__avatar">${escapeHtml((user.full_name || '?').trim().charAt(0).toUpperCase())}</span><span class="group-user-option__body"><strong>${escapeHtml(user.full_name)}</strong><small>${escapeHtml(user.role)}${user.group_name ? ` · ${escapeHtml(user.group_name)}` : ''}</small>${window.presenceMarkup?.(user.presence_status, user.status_message) || ''}</span></label>`
    const renderSection = (title, users, open = false) => {
        if (!users.length) return ''
        const sortedUsers = [...users].sort((first, second) => {
            const firstGroup = first.group_name || 'No group'
            const secondGroup = second.group_name || 'No group'
            return firstGroup.localeCompare(secondGroup, 'uk') || first.full_name.localeCompare(second.full_name, 'uk')
        })
        return `<details class="group-user-section" ${open ? 'open' : ''}><summary><span>${title}</span><b>${users.length}</b></summary><div>${sortedUsers.map(renderOption).join('')}</div></details>`
    }
    const studentGroups = Object.entries(sections['Students'].reduce((groups, user) => {
        const group = user.group_name || 'No group'
        if (!groups[group]) groups[group] = []
        groups[group].push(user)
        return groups
    }, {})).sort(([first], [second]) => first.localeCompare(second, 'uk'))
    const studentSection = studentGroups.length ? `<details class="group-user-section" open><summary><span>Students · by group</span><b>${sections['Students'].length}</b></summary><div>${studentGroups.map(([group, users]) => `<details class="group-user-subsection" open><summary><span>${escapeHtml(group)}</span><b>${users.length}</b></summary><div>${users.sort((first, second) => first.full_name.localeCompare(second.full_name, 'en')).map(renderOption).join('')}</div></details>`).join('')}</div></details>` : ''
    $('#groupUserList').innerHTML = renderSection('Dean’s office', sections['Dean’s office'], true) + renderSection('Faculty', sections['Faculty'], true) + studentSection || '<p class="empty">No users found.</p>'
}

function closeGroupDialog() {
    $('#groupDialog').classList.add('hidden')
    state.selectedGroupUsers.clear()
    $('#groupTitle').value = ''
    $('#groupDescription').value = ''
    $('#groupAvatar').value = ''
    $('#groupAlert').textContent = ''
}

async function createGroup() {
    const title = $('#groupTitle').value.trim()
    const description = $('#groupDescription').value.trim()
    const avatarFile = $('#groupAvatar').files[0]
    if (!title) return $('#groupAlert').textContent = 'Enter a group name'
    try {
        const avatar = avatarFile ? await readFileAsDataUrl(avatarFile) : ''
        const data = await api('/api/groups', { method: 'POST', body: JSON.stringify({ title, description, avatar, member_ids: [...state.selectedGroupUsers] }) })
        closeGroupDialog()
        await loadChats()
        await openChat(data.chat_id)
    } catch (error) {
        $('#groupAlert').textContent = error.message
    }
}

async function showGroupDetails() {
    if (!state.current || state.current.chat_type !== 'group') return
    const button = $('#groupInfoBtn')
    button.classList.add('is-loading')
    button.setAttribute('aria-expanded', 'true')
    try {
        const data = await api(`/api/groups/${state.current.id}`)
        const group = data.group
        const members = Array.isArray(group.members) ? group.members : []
        $('#groupDetailsTitle').textContent = group.title || 'Group chat'
        $('#groupDetailsDescription').textContent = group.description?.trim() || 'No description has been added for this group.'
        $('#groupDetailsMemberCount').textContent = members.length
        const avatar = $('#groupDetailsAvatar')
        if (group.avatar) {
            avatar.src = group.avatar
            avatar.classList.remove('hidden')
        } else {
            avatar.removeAttribute('src')
            avatar.classList.add('hidden')
        }
        $('#groupDetailsMembers').innerHTML = members.length ? members.map(member => `
            <article class="group-details-member">
                <span class="group-details-member__avatar" aria-hidden="true">${escapeHtml((member.full_name || '?').trim().charAt(0).toUpperCase())}</span>
                <span class="group-details-member__body"><strong>${escapeHtml(member.full_name || 'User')}</strong><small>${escapeHtml(member.role || 'Member')}</small></span>
                ${member.is_admin ? '<span class="group-details-admin">Administrator</span>' : ''}
            </article>`).join('') : '<p class="empty">No members found.</p>'
        $('#groupDetailsDialog').classList.remove('hidden')
        $('#groupDetailsDialog').querySelector('.group-details-panel').scrollTop = 0
    } catch (error) {
        button.setAttribute('aria-expanded', 'false')
        modalAlert(error.message, { title: 'Could not load the group' })
    } finally {
        button.classList.remove('is-loading')
    }
}

function closeGroupDetails() {
    $('#groupDetailsDialog').classList.add('hidden')
    $('#groupInfoBtn').setAttribute('aria-expanded', 'false')
}

function userGroup(role) {
    return role === 'Студент' ? 'Students' : role === 'Викладач' ? 'Faculty' : 'Dean’s office'
}

function renderUsers() {
    const query = $('#userSearch').value.trim().toLowerCase()
    const filteredUsers = state.users.filter(user => {
        const matchesRole = state.userRoleFilter === 'All' || userGroup(user.role) === state.userRoleFilter
        const matchesSearch = !query || `${user.full_name} ${user.email}`.toLowerCase().includes(query)
        return matchesRole && matchesSearch
    })
    $('#userList').innerHTML = filteredUsers.length ? filteredUsers.map(user => `
        <button class="user-option ${state.selectedUser?.id === user.id ? 'is-selected' : ''}" type="button" data-user-id="${user.id}">
            <span class="user-option__avatar">${escapeHtml((user.full_name || '?').trim().charAt(0).toUpperCase())}</span>
            <span class="user-option__body"><strong>${escapeHtml(user.full_name)}</strong><small>${escapeHtml(user.role)} · ${escapeHtml(user.email)}</small>${window.presenceMarkup?.(user.presence_status, user.status_message) || ''}</span>
            <span class="user-option__check">✓</span>
        </button>`).join('') : '<p class="empty user-list__empty">No users found.</p>'
    $('#confirmChatBtn').disabled = !state.selectedUser
}

function closeDialog() {
    $('#createDialog').classList.add('hidden')
    state.selectedUser = null
    state.userRoleFilter = 'All'
    $('#userSearch').value = ''
    document.querySelectorAll('.user-filter').forEach(button => button.classList.toggle('is-active', button.dataset.userRole === 'All'))
    showError('')
}

$('#createChatBtn').addEventListener('click', async () => {
    $('#createDialog').classList.remove('hidden')
    try {
        await loadUsers()
    } catch (error) {
        showError(error.message)
    }
})

document.querySelectorAll('[data-close]').forEach(element => {
    element.addEventListener('click', closeDialog)
})

$('#createGroupBtn').addEventListener('click', async () => {
    $('#groupDialog').classList.remove('hidden')
    await loadUsers()
})

document.querySelectorAll('[data-close-group]').forEach(element => element.addEventListener('click', closeGroupDialog))
$('#groupUserList').addEventListener('change', event => {
    if (!event.target.matches('input[type="checkbox"]')) return
    const id = Number(event.target.value)
    if (event.target.checked) state.selectedGroupUsers.add(id)
    else state.selectedGroupUsers.delete(id)
})
$('#confirmGroupBtn').addEventListener('click', createGroup)
$('#groupInfoBtn').addEventListener('click', showGroupDetails)
document.querySelectorAll('[data-close-group-details]').forEach(element => element.addEventListener('click', closeGroupDetails))
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#groupDetailsDialog').classList.contains('hidden')) closeGroupDetails()
})

$('#userSearch').addEventListener('input', renderUsers)

document.querySelectorAll('.user-filter').forEach(button => {
    button.addEventListener('click', () => {
        state.userRoleFilter = button.dataset.userRole
        document.querySelectorAll('.user-filter').forEach(item => item.classList.toggle('is-active', item === button))
        renderUsers()
    })
})

$('#userList').addEventListener('click', event => {
    const option = event.target.closest('[data-user-id]')
    if (!option) return
    state.selectedUser = state.users.find(user => user.id === Number(option.dataset.userId))
    renderUsers()
})

$('#confirmChatBtn').addEventListener('click', async () => {
    try {
        const userId = state.selectedUser?.id
        if (!userId) return showError('Select a user')

        const data = await api('/api/chats', {
            method: 'POST',
            body: JSON.stringify({ user_id: userId })
        })

        closeDialog()
        await loadChats()
        await openChat(data.chat_id)
    } catch (error) {
        showError(error.message)
    }
})

$('#emojiBtn').addEventListener('click', () => {
    const input = $('#messageInput')
    const emoji = '😊'
    const start = input.selectionStart
    const end = input.selectionEnd
    const value = input.value

    input.value = value.slice(0, start) + emoji + value.slice(end)
    input.selectionStart = input.selectionEnd = start + emoji.length
    input.focus()
    autoResizeTextarea(input)
})

$('#messageInput').addEventListener('input', event => {
    autoResizeTextarea(event.target)
    queueChatDraftSave()
    $('#draftStatus').textContent = event.target.value ? 'Syncing draft…' : ''
})

$('#scheduleMessageBtn').addEventListener('click', () => {
    const input = $('#scheduledAt')
    if (input.classList.contains('hidden')) {
        input.min = localDateTimeValue(new Date(Date.now() + 2 * 60_000))
        input.value = input.min
        input.classList.remove('hidden')
        $('#scheduleMessageBtn').classList.add('is-active')
        input.focus()
    } else {
        input.value = ''
        input.classList.add('hidden')
        $('#scheduleMessageBtn').classList.remove('is-active')
    }
})

function localDateTimeValue(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    return local.toISOString().slice(0, 16)
}

$('#messageFile').addEventListener('change', event => { renderFilePreview(event.target.files); if (event.target.files.length) openFileDialog() })
$('#filePreview').addEventListener('click', event => {
    if (event.target.id === 'openFileDialog') openFileDialog()
    if (event.target.id === 'removeFile') {
        $('#messageFile').value = ''
        renderFilePreview([])
    }
})

document.querySelectorAll('[data-close-files]').forEach(element => element.addEventListener('click', closeFileDialog))
$('#fileDialogList').addEventListener('click', event => {
    const remove = event.target.closest('[data-remove-selected]')
    if (!remove) return
    state.selectedFiles.splice(Number(remove.dataset.removeSelected), 1)
    const transfer = new DataTransfer()
    state.selectedFiles.forEach(file => transfer.items.add(file))
    $('#messageFile').files = transfer.files
    closeFileDialog()
    renderFilePreview(state.selectedFiles)
    if (state.selectedFiles.length) openFileDialog()
})

function insertNewLine() {
    const input = $('#messageInput')
    const start = input.selectionStart
    const end = input.selectionEnd
    input.value = input.value.slice(0, start) + '\n' + input.value.slice(end)
    input.selectionStart = input.selectionEnd = start + 1
    input.focus()
    autoResizeTextarea(input)
    $('#sendChoice').classList.add('hidden')
}

function openSendChoice() {
    $('#sendChoice').classList.remove('hidden')
    $('#sendEnterBtn').focus()
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('Could not read the file'))
        reader.readAsDataURL(file)
    })
}

function renderFilePreview(files) {
    state.selectedFiles = Array.from(files || [])
    const preview = $('#filePreview')
    preview.classList.toggle('hidden', !state.selectedFiles.length)
    preview.innerHTML = state.selectedFiles.length ? `<span>📎</span><strong>${state.selectedFiles.length} file(s) selected</strong><small>${formatFileSize(state.selectedFiles.reduce((total, file) => total + file.size, 0))}</small><button type="button" id="openFileDialog">Review</button><button type="button" id="removeFile" aria-label="Remove files">×</button>` : ''
}

function openFileDialog() {
    const list = $('#fileDialogList')
    $('#fileDialogSummary').textContent = `${state.selectedFiles.length} file(s), ${formatFileSize(state.selectedFiles.reduce((total, file) => total + file.size, 0))}`
    list.innerHTML = state.selectedFiles.map((file, index) => {
        const url = URL.createObjectURL(file)
        const preview = file.type.startsWith('image/') ? `<img src="${url}" alt="" />` : file.type.startsWith('video/') ? `<video src="${url}" controls></video>` : `<span class="file-dialog__icon">📄</span>`
        return `<article class="file-dialog__item" data-preview-url="${url}">${preview}<div><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.type || 'Unknown format')} · ${formatFileSize(file.size)}</small></div><button type="button" data-remove-selected="${index}" aria-label="Delete file">×</button></article>`
    }).join('')
    $('#fileDialog').classList.remove('hidden')
    document.body.classList.add('modal-open')
}

function closeFileDialog() {
    document.querySelectorAll('[data-preview-url]').forEach(item => URL.revokeObjectURL(item.dataset.previewUrl))
    $('#fileDialog').classList.add('hidden')
    document.body.classList.remove('modal-open')
}

function formatVoiceTime(seconds) {
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function updateVoiceTimer() {
    $('#voiceTimer').textContent = formatVoiceTime(Math.floor((Date.now() - state.voiceStartedAt) / 1000))
}

function resetVoice() {
    if (state.voiceTimer) clearInterval(state.voiceTimer)
    state.voiceTimer = null
    state.recorder = null
    state.voiceChunks = []
    state.voiceBlob = null
    if (state.voicePreviewUrl) URL.revokeObjectURL(state.voicePreviewUrl)
    state.voicePreviewUrl = null
    $('#voicePreview').classList.add('hidden')
    $('#voiceBtn').classList.remove('is-recording')
    $('#voiceBtn').disabled = false
    $('#voiceTimer').textContent = '00:00'
    $('#voicePreviewAudio').removeAttribute('src')
    $('#voicePreviewAudio').load()
}

async function startVoiceRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        modalAlert('Your browser does not support voice recording')
        return
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type)) || ''
        state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        state.voiceChunks = []
        state.voiceStartedAt = Date.now()
        state.voiceCancelled = false
        state.recorder.ondataavailable = event => { if (event.data.size) state.voiceChunks.push(event.data) }
        state.recorder.onstop = () => {
            stream.getTracks().forEach(track => track.stop())
            if (state.voiceCancelled) {
                resetVoice()
                return
            }
            state.voiceBlob = new Blob(state.voiceChunks, { type: state.recorder.mimeType || 'audio/webm' })
            state.voicePreviewUrl = URL.createObjectURL(state.voiceBlob)
            $('#voicePreviewAudio').src = state.voicePreviewUrl
            $('#voicePreview').classList.remove('hidden')
            $('#voiceBtn').classList.remove('is-recording')
            $('#voiceBtn').disabled = false
            if (state.voiceTimer) clearInterval(state.voiceTimer)
            $('#voiceTimer').textContent = formatVoiceTime(Math.floor((Date.now() - state.voiceStartedAt) / 1000))
        }
        state.recorder.start()
        $('#voiceBtn').classList.add('is-recording')
        $('#voiceBtn').disabled = false
        state.voiceTimer = setInterval(updateVoiceTimer, 1000)
    } catch (error) {
        modalAlert('Could not access the microphone. Allow access in your browser settings.')
    }
}

function stopVoiceRecording() {
    if (state.recorder?.state === 'recording') state.recorder.stop()
}

async function sendVoiceMessage() {
    if (!state.voiceBlob || !state.current) return
    try {
        if (state.voiceBlob.size > 10 * 1024 * 1024) throw new Error('Voice messages cannot exceed 10 MB')
        const fileName = `voice-${Date.now()}.${state.voiceBlob.type.includes('mp4') ? 'm4a' : 'webm'}`
        const data = await readFileAsDataUrl(new File([state.voiceBlob], fileName, { type: state.voiceBlob.type }))
        await api(`/api/chats/${state.current.id}/messages`, { method: 'POST', body: JSON.stringify({ content: '', attachment: { name: fileName, type: state.voiceBlob.type, data } }) })
        resetVoice()
        await loadChats()
        await openChat(state.current.id)
    } catch (error) {
        modalAlert(error.message)
    }
}

async function sendCurrentMessage() {
    const input = $('#messageInput')
    const content = input.value.trim()
    const fileInput = $('#messageFile')
    const files = state.selectedFiles
    const scheduledValue = $('#scheduledAt').value
    const scheduledAt = scheduledValue ? new Date(scheduledValue).toISOString() : null

    if ((!content && !files.length) || !state.current) return

    try {
        if (files.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) throw new Error('Total attachment size per message must be no more than 10 MB')
        const attachments = await Promise.all(files.map(async file => ({ name: file.name, type: file.type || 'application/octet-stream', data: await readFileAsDataUrl(file) })))
        await api(`/api/chats/${state.current.id}/messages`, {
            method: 'POST',
            body: JSON.stringify({ content, attachments, scheduled_at: scheduledAt, topic_id: state.current.chat_type === 'group' && state.topicByChat[state.current.id] ? Number(state.topicByChat[state.current.id]) : null })
        })

        clearTimeout(state.draftTimer)
        input.value = ''
        await saveChatDraft(state.current.id, '')
        $('#draftStatus').textContent = scheduledAt ? `Scheduled for ${new Date(scheduledAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}` : ''
        $('#scheduledAt').value = ''
        $('#scheduledAt').classList.add('hidden')
        $('#scheduleMessageBtn').classList.remove('is-active')
        fileInput.value = ''
        renderFilePreview([])
        closeFileDialog()
        autoResizeTextarea(input)
        await loadChats()
        await openChat(state.current.id)
        $('#sendChoice').classList.add('hidden')
    } catch (error) {
        modalAlert(error.message)
    }
}

$('#messageInput').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    if ($('#messageInput').value.trim()) openSendChoice()
})

$('#voiceBtn').addEventListener('click', () => {
    if (state.recorder?.state === 'recording') stopVoiceRecording()
    else if (!state.voiceBlob) startVoiceRecording()
})

$('#cancelVoiceBtn').addEventListener('click', () => {
    if (state.recorder?.state === 'recording') {
        state.voiceCancelled = true
        state.recorder.stop()
    } else resetVoice()
})

$('#sendVoiceBtn').addEventListener('click', sendVoiceMessage)

$('#newLineBtn').addEventListener('click', insertNewLine)
$('#sendEnterBtn').addEventListener('click', sendCurrentMessage)

$('#messageForm').addEventListener('submit', async event => {
    event.preventDefault()
    await sendCurrentMessage()
})

async function init() {
    try {
        const data = await api('/api/me')
        state.user = data.user
        $('#navProfile').href = state.user.redirect || (state.user.role === 'Викладач' ? '/profileTeacher' : '/profileStudent')
        $('#userName').textContent = state.user.full_name
        $('#userAvatar').textContent = state.user.full_name[0].toUpperCase()
    } catch (error) {
        if (error.message === 'Not authorized' || error.message === 'Invalid or expired token') {
            location.href = '/'
            return
        }

        showError(`Could not verify authentication: ${error.message}`)
        return
    }

    try {
        await loadChats()
    } catch (error) {
        showError(`Could not load chats: ${error.message}`)
    }
}

init()
window.setInterval(() => { if (!document.hidden) loadChats().catch(() => {}) }, 60_000)
window.setInterval(() => {
    if (state.current && !document.hidden) openChat(state.current.id, { silent: true }).catch(() => {})
}, 30_000)
