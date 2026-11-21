const $ = (selector) => document.querySelector(selector)
const number = (value) => new Intl.NumberFormat("uk-UA").format(Number(value || 0))
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]))
let adminTab = "users", adminRows = [], editingItem = null
const adminConfig = {
  users: { title:"Користувачі",url:"/api/dean/users",key:"users",fields:[['full_name','ПІБ','text',true],['email','Email','email',true],['role','Роль','select',true,['ДеканФІКТ','Завідувач Кафедри','Викладач','Студент']],['password','Пароль (необов’язково; можна встановити пізніше)','password',false],['department','Кафедра','text'],['group_name','Група','text'],['position','Посада','text'],['phone','Телефон','text'],['course','Курс','text'],['study_level','Рівень навчання','text']],columns:[['full_name','ПІБ'],['email','Email'],['role','Роль'],['created_at','Створено'],['profile_updated_at','Профіль змінено']]},
  news: { title:"Новини",url:"/api/news",key:"news",fields:[['title','Заголовок','text',true],['content','Текст','textarea',true],['categories','Категорії через кому','text'],['status','Статус','select',true,['draft','published']],['is_pinned','Закріпити','checkbox']],columns:[['title','Заголовок'],['author_name','Автор'],['status','Статус'],['created_at','Створено']]},
  events: { title:"Події",url:"/api/events",key:"events",fields:[['title','Назва','text',true],['summary','Короткий опис','text'],['description','Опис','textarea',true],['event_type','Тип події','text'],['format','Формат','select',true,['offline','online','hybrid']],['location','Місце проведення','text'],['starts_at','Початок','datetime-local',true],['ends_at','Завершення','datetime-local',true],['registration_deadline','Дедлайн реєстрації','datetime-local'],['capacity','Місткість (порожньо — без ліміту)','number'],['meeting_url','Посилання на зустріч','url'],['contact','Контакт','text'],['status','Статус','select',true,['draft','published','cancelled']]],columns:[['title','Назва'],['creator_name','Автор'],['starts_at','Початок'],['status','Статус']]},
  categories: { title:"Категорії новин",url:"/api/news/categories",key:"categories",fields:[['name','Назва','text',true]],columns:[['name','Назва'],['news_count','Кількість новин']]},
  students: { title:"Студенти та активності",url:"/api/developer/students",key:"students",readonly:true,columns:[['full_name','ПІБ'],['email','Email'],['group_name','Група'],['course','Курс'],['activity_count','Активності']]},
  achievements: { title:"Досягнення",url:"/api/developer/achievements",key:"achievements",readonly:true,fields:[['title','Назва','text',true],['description','Опис','textarea'],['achievement_type','Тип','text',true],['event_name','Подія','text'],['organizer','Організатор','text'],['location','Місце','text'],['achievement_date','Дата','date'],['result','Результат','text'],['link','Посилання','url'],['is_public','Публічне','checkbox']],columns:[['title','Досягнення'],['full_name','Автор'],['achievement_type','Тип'],['is_public','Публічне']]},
  chats: { title:"Чати та групи",url:"/api/developer/chats",key:"chats",readonly:true,columns:[['chat_type','Тип'],['title','Назва групи / учасники'],['creator_name','Створив'],['member_count','Учасники'],['message_count','Повідомлення'],['last_message_at','Останнє повідомлення']]}
}
function showAdminMessage(message,error=false){const el=$("#adminMessage");el.textContent=message;el.classList.toggle("hidden",!message);el.classList.toggle("is-error",error)}
function adminUrl(item){return `${adminConfig[adminTab].url}/${item.id}`}
function rowValue(key,row){if(["starts_at","created_at","profile_updated_at","last_message_at"].includes(key))return row[key]?new Date(row[key]).toLocaleString("uk-UA"):"—";if(key==="title"&&adminTab==="chats")return row.title||row.participants||"Особистий чат";if(key==="activity_count")return (row.activities||[]).length;if(key==="is_public")return row[key]?"Так":"Ні";return row[key]??"—"}
function renderAdmin(){const c=adminConfig[adminTab];$("#adminTitle").textContent=c.title;$("#userSortWrap").classList.toggle("hidden",adminTab!=="users");$("#adminCreate").classList.toggle("hidden",Boolean(c.readonly));$("#adminCreate").textContent=adminTab==="news"?"＋ Створити новину":adminTab==="events"?"＋ Створити подію":"＋ Додати";$("#adminList").innerHTML=adminRows.length?`<div class="admin-table-wrap"><table class="admin-table"><thead><tr>${c.columns.map(([,label])=>`<th>${escapeHtml(label)}</th>`).join("")}<th>Дії</th></tr></thead><tbody>${adminRows.map(row=>`<tr>${c.columns.map(([key,label])=>`<td data-label="${escapeHtml(label)}">${escapeHtml(rowValue(key,row))}</td>`).join("")}<td class="admin-row-actions" data-label="Дії">${adminTab==="chats"?`<button data-view-chat="${row.id}">Деталі</button><button class="is-danger" data-delete="${row.id}">Видалити</button>`:adminTab==="students"?`<button data-view-student="${row.id}">Профіль та активності</button>`:adminTab==="achievements"?`<button data-edit="${row.id}">Редагувати</button><button class="is-danger" data-delete="${row.id}">Видалити</button>`:c.readonly?`<button class="is-danger" data-delete="${row.id}">Видалити</button>`:`<button data-edit="${row.id}">Редагувати</button><button class="is-danger" data-delete="${row.id}">Видалити</button>`}</td></tr>`).join("")}</tbody></table></div>`:'<p class="stats-loading">Поки що записів немає.</p>'}
async function loadAdmin(){const c=adminConfig[adminTab];try{const r=await fetch(c.url),data=await r.json();if(!r.ok)throw Error(data.error||"Не вдалося завантажити список");adminRows=data[c.key]||[];if(adminTab==="users")sortAdminUsers();renderAdmin()}catch(e){$("#adminList").innerHTML=`<p class="dashboard-error">${escapeHtml(e.message)}</p>`}}
function sortAdminUsers(){const key=$("#userSort")?.value||"created_at";adminRows.sort((a,b)=>key==="full_name"?String(a.full_name).localeCompare(String(b.full_name),"uk"):new Date(b[key]||0)-new Date(a[key]||0))}
const userFieldsByRole = {
  "Студент": ["group_name", "course", "study_level", "phone"],
  "Викладач": ["department", "position", "phone"],
  "Завідувач Кафедри": ["department", "position", "phone"],
  "ДеканФІКТ": ["department", "position", "phone"],
  "Розробник": ["phone"]
}
function renderAdminFields(fields, values = {}) {
  return fields.map(([key,label,type="text",required=false,options=[]]) => {
    let value = values[key] ?? ""
    if (key === "categories") value = (values.categories || []).map(x => x.name).join(", ")
    if (type === "datetime-local" && value) value = new Date(value).toISOString().slice(0,16)
    const req = required ? "required" : ""
    if (type === "select") {
      const choices = value === "Розробник" && !options.includes(value) ? [...options, value] : options
      return `<label>${escapeHtml(label)}<select name="${key}" ${req}>${choices.map(opt => `<option value="${escapeHtml(opt)}" ${value===opt?"selected":""}>${escapeHtml(opt)}</option>`).join("")}</select></label>`
    }
    if (type === "textarea") return `<label class="is-wide">${escapeHtml(label)}<textarea name="${key}" rows="5" ${req}>${escapeHtml(value)}</textarea></label>`
    if (type === "checkbox") return `<label class="admin-check"><input type="checkbox" name="${key}" ${value?"checked":""}> ${escapeHtml(label)}</label>`
    return `<label>${escapeHtml(label)}<input name="${key}" type="${type}" value="${escapeHtml(value)}" ${req} ${type==="number"?'min="1"':''}></label>`
  }).join("")
}
function fieldsForUserRole(role) {
  const fields = adminConfig.users.fields
  const visibleKeys = new Set(["full_name", "email", "role", "password", ...(userFieldsByRole[role] || [])])
  return fields.filter(([key]) => visibleKeys.has(key))
}
function openAdminForm(item=null) {
  editingItem = item
  const config = adminConfig[adminTab]
  $("#adminFormTitle").textContent = item ? `Редагувати: ${item.title||item.full_name||item.name||"запис"}` : `Створити: ${config.title.toLowerCase()}`
  const fieldHost = $("#adminFields")
  if (adminTab === "users") {
    const values = {...(item || {}), role: item?.role || "Студент", password: ""}
    const renderRoleFields = () => {
      const role = fieldHost.querySelector('[name="role"]')?.value || values.role || "Студент"
      fieldHost.innerHTML = renderAdminFields(fieldsForUserRole(role), values)
      fieldHost.querySelector('[name="role"]')?.addEventListener("change", (event) => {
        const current = Object.fromEntries(new FormData($("#adminForm")).entries())
        Object.assign(values, current, {role: event.target.value})
        renderRoleFields()
        fieldHost.querySelector('[name="role"]')?.focus()
      })
    }
    renderRoleFields()
  } else {
    fieldHost.innerHTML = renderAdminFields(config.fields, item || {})
  }
  $("#adminDialog").showModal()
}
async function submitAdmin(event){event.preventDefault();const c=adminConfig[adminTab],form=new FormData(event.currentTarget),body={};for(const [key,label,type] of c.fields){if(type==="checkbox")body[key]=form.has(key);else if(key==="categories")body[key]=String(form.get(key)||"").split(",").map(v=>v.trim()).filter(Boolean);else body[key]=String(form.get(key)||"").trim()}if(adminTab==="events")for(const key of ["starts_at","ends_at","registration_deadline"])body[key]=body[key]?new Date(body[key]).toISOString():"";if(adminTab==="events"&&body.capacity==="")body.capacity=null;const url=editingItem?adminUrl(editingItem):c.url,method=editingItem?"PUT":"POST";try{const r=await fetch(url,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),data=await r.json();if(!r.ok)throw Error(data.error||"Не вдалося зберегти запис");$("#adminDialog").close();if(adminTab==="users"&&!editingItem&&data.setupToken){const link=`${location.origin}/?token=${encodeURIComponent(data.setupToken)}`;$("#chatDetailTitle").textContent="Акаунт створено — пароль потрібно встановити";$("#chatDetailBody").innerHTML=`<p>Передайте користувачу посилання для встановлення пароля. Воно діє 7 днів.</p><label class="setup-link-label">Посилання для користувача<input id="setupLink" readonly value="${escapeHtml(link)}"></label><button class="admin-primary" id="copySetupLink" type="button">Копіювати посилання</button>`;$("#chatDetailDialog").showModal();$("#copySetupLink").onclick=async()=>{await navigator.clipboard.writeText(link);$("#copySetupLink").textContent="Скопійовано"}}else showAdminMessage("Зміни збережено.");await loadAdmin()}catch(e){showAdminMessage(e.message,true)}}
async function deleteAdmin(id){const item=adminRows.find(row=>String(row.id)===String(id));if(!item||!confirm(`Видалити «${item.title||item.full_name||item.name||item.participants||"запис"}»? Цю дію не можна скасувати.`))return;const endpoint=adminTab==="chats"?`${adminUrl(item)}`:adminTab==="achievements"?`${adminUrl(item)}`:adminTab==="students"?"":adminUrl(item);if(!endpoint)return;try{const r=await fetch(endpoint,{method:"DELETE"}),data=await r.json();if(!r.ok)throw Error(data.error||"Не вдалося видалити запис");showAdminMessage(data.message||"Запис видалено.");await loadAdmin()}catch(e){showAdminMessage(e.message,true)}}
async function showChatDetails(id){try{const r=await fetch(`/api/developer/chats/${id}`),data=await r.json();if(!r.ok)throw Error(data.error||"Помилка завантаження чату");const chat=data.chat,people=chat.chat_type==="group"?chat.members:chat.direct_participants.filter(Boolean);$("#chatDetailTitle").textContent=chat.title||"Особистий чат";$("#chatDetailBody").innerHTML=`<p><b>Створено:</b> ${escapeHtml(chat.creator_name||"—")} · ${new Date(chat.created_at).toLocaleString("uk-UA")}</p><p><b>Опис:</b> ${escapeHtml(chat.description||"—")}</p><h3>Учасники (${people.length})</h3><ul>${people.map(p=>`<li>${escapeHtml(p.full_name)} · ${escapeHtml(p.email)} · ${escapeHtml(p.role)}${p.is_admin?" · адміністратор групи":""}</li>`).join("")}</ul><h3>Повідомлення (останні ${data.messages.length})</h3><div class="admin-message-history">${data.messages.slice().reverse().map(m=>`<article><b>${escapeHtml(m.sender_name||"Видалений користувач")}</b><small>${new Date(m.created_at).toLocaleString("uk-UA")}</small><p>${escapeHtml(m.content||"")}</p>${m.file_name?`<small>Файл: ${escapeHtml(m.file_name)}</small>`:""}</article>`).join("")||"<p>Повідомлень немає.</p>"}</div>`;$("#chatDetailDialog").showModal()}catch(e){showAdminMessage(e.message,true)}}
function showStudentDetails(id){const student=adminRows.find(x=>String(x.id)===String(id));if(!student)return;$("#chatDetailTitle").textContent=student.full_name;$("#chatDetailBody").innerHTML=`<p><b>Email:</b> ${escapeHtml(student.email)} · <b>Група:</b> ${escapeHtml(student.group_name||"—")} · <b>Курс:</b> ${escapeHtml(student.course||"—")} · <b>Рівень:</b> ${escapeHtml(student.study_level||"—")}</p><p><b>Телефон:</b> ${escapeHtml(student.phone||"—")} · <b>Кафедра:</b> ${escapeHtml(student.department||"—")}</p><h3>Активності (${student.activities.length})</h3><div class="admin-message-history">${student.activities.map(a=>`<article><b>${escapeHtml(a.title)}</b><small>${escapeHtml(a.category_name)} · ${escapeHtml(a.activity_date||"Дата не вказана")} · ${a.is_public?"Публічна":"Приватна"}</small><p>${escapeHtml(a.description||"")}</p><small>${escapeHtml(a.organizer||"")} · ${escapeHtml(a.location||"")}</small><button class="is-danger" data-delete-activity="${a.id}">Видалити активність</button></article>`).join("")||"<p>Активностей немає.</p>"}</div>`;$("#chatDetailDialog").showModal()}

function renderRows(container, rows, type) {
  if (!rows.length) { container.innerHTML = '<p class="stats-loading">Поки що немає даних.</p>'; return }
  container.innerHTML = rows.map((row) => {
    const values = type === "group"
      ? `<b>${number(row.students)}</b> студентів`
      : `<b>${number(row.teachers)}</b> викл. · ${number(row.students)} студ.`
    return `<div class="stats-row"><span class="stats-row__name" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span><span class="stats-row__values">${values}</span></div>`
  }).join("")
}

function render(data) {
  const { overview, activity, groups, departments } = data
  $("#studentsCount").textContent = number(overview.students)
  $("#teachersCount").textContent = number(overview.teachers)
  $("#newsCount").textContent = number(overview.news)
  $("#eventsCount").textContent = number(overview.events)
  $("#materialsCount").textContent = number(overview.materials)
  $("#dayActions").textContent = number(activity.day_actions)
  $("#dayUsers").textContent = number(activity.day_users)
  $("#weekActions").textContent = number(activity.week_actions)
  $("#weekUsers").textContent = number(activity.week_users)
  renderRows($("#groupsList"), groups, "group")
  renderRows($("#departmentsList"), departments, "department")
  $("#updatedAt").textContent = `Оновлено: ${new Intl.DateTimeFormat("uk-UA", { dateStyle: "medium", timeStyle: "short" }).format(new Date())}`
}

async function init() {
  try {
    const me = await fetch("/api/me")
    if (!me.ok) { window.location.href = "/"; return }
    const user = (await me.json()).user
    if (user.role !== "ДеканФІКТ" && user.role !== "Розробник") { window.location.href = "/home"; return }
    $("#userName").textContent = user.full_name || "Декан"
    $("#userAvatar").textContent = (user.full_name || "?").trim().charAt(0).toUpperCase()
    $("#navProfile").href = user.redirect || "/profileTeacher"
    if(user.role==="Розробник"){
      document.body.classList.add("platform-admin")
      $("#adminHomeLink").href="/admin";$("#adminHomeLink").textContent="Адмін-панель"
      if(!document.querySelector('.topbar__nav a[href="/profiles-review"]')){const profilesLink=document.createElement("a");profilesLink.className="navlink";profilesLink.href="/profiles-review";profilesLink.textContent="Профілі кафедри";$("#adminHomeLink").after(profilesLink)}
      $("#developerOverview").classList.remove("hidden");$("#developerShortcuts").classList.remove("hidden")
      $("#dashboardHero .eyebrow").textContent="КОНТРОЛЬ ПЛАТФОРМИ";$("#dashboardHero h1").textContent="Адмін-панель";$("#dashboardHero p:not(.eyebrow)").textContent="Керуйте користувачами, контентом і спільнотою PolyConnect з одного місця."
      const response=await fetch("/api/developer/overview"),data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Не вдалося завантажити огляд платформи")
      const o=data.overview;$("#devUsersCount").textContent=number(o.users);$("#devNewsCount").textContent=number(o.news);$("#devEventsCount").textContent=number(o.events);$("#devAchievementsCount").textContent=number(o.achievements);$("#devChatsCount").textContent=number(o.chats);$("#devChatBreakdown").textContent=`${number(o.groups)} груп · ${number(o.messages)} повідомлень`;$("#updatedAt").textContent=`Оновлено: ${new Intl.DateTimeFormat("uk-UA",{dateStyle:"medium",timeStyle:"short"}).format(new Date())}`
    }else{
      document.querySelectorAll('[data-admin-tab="students"],[data-admin-tab="achievements"],[data-admin-tab="chats"]').forEach(el=>el.classList.add("hidden"))
      const response=await fetch("/api/dean-dashboard");const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||"Не вдалося завантажити дані");render(data)
    }
    document.querySelectorAll("[data-admin-tab]").forEach(button=>button.addEventListener("click",()=>{adminTab=button.dataset.adminTab;document.querySelectorAll("[data-admin-tab]").forEach(x=>x.classList.toggle("is-active",x===button));showAdminMessage("");loadAdmin()}))
    document.querySelectorAll("[data-go-tab]").forEach(button=>button.addEventListener("click",()=>{document.querySelector(`[data-admin-tab="${button.dataset.goTab}"]`)?.click();$("#adminSection").scrollIntoView({behavior:"smooth",block:"start"})}))
    $("#userSort").addEventListener("change",()=>{sortAdminUsers();renderAdmin()});$("#adminCreate").addEventListener("click",()=>openAdminForm());$("#adminList").addEventListener("click",async event=>{const edit=event.target.closest("[data-edit]"),del=event.target.closest("[data-delete]"),view=event.target.closest("[data-view-chat]"),student=event.target.closest("[data-view-student]"),activity=event.target.closest("[data-delete-activity]");if(edit)openAdminForm(adminRows.find(row=>String(row.id)===edit.dataset.edit));if(del)deleteAdmin(del.dataset.delete);if(view)showChatDetails(view.dataset.viewChat);if(student)showStudentDetails(student.dataset.viewStudent);if(activity&&confirm("Видалити активність студента?")){const r=await fetch(`/api/developer/activities/${activity.dataset.deleteActivity}`,{method:"DELETE"}),d=await r.json();if(!r.ok)showAdminMessage(d.error,true);else{showAdminMessage(d.message);$("#chatDetailDialog").close();await loadAdmin()}}});$("#adminForm").addEventListener("submit",submitAdmin);$("#adminClose").addEventListener("click",()=>$("#adminDialog").close());$("#adminCancel").addEventListener("click",()=>$("#adminDialog").close());$("#chatDetailClose").addEventListener("click",()=>$("#chatDetailDialog").close());loadAdmin()
  } catch (error) {
    $("#dashboardError").textContent = error.message
    $("#dashboardError").classList.remove("hidden")
    $("#updatedAt").textContent = "Дані тимчасово недоступні"
  }
}
init()
