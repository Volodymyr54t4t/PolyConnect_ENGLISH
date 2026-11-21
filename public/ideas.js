(() => {
  const $ = (s, root=document) => root.querySelector(s)
  const list=$('#ideaList'), formDialog=$('#ideaDialog'), detailDialog=$('#detailDialog'), form=$('#ideaForm')
  let categories=[], statuses=[], staff=false, ideas=[], currentId=null, editingId=null, toastTimer
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const date = value => new Intl.DateTimeFormat('en-US',{day:'numeric',month:'short',year:'numeric'}).format(new Date(value))
  const showToast = message => {const el=$('#toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2800)}
  async function api(url, options={}) {
    const response=await fetch(url,{credentials:'same-origin',...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}})
    const data=await response.json().catch(()=>({}))
    if(response.status===401){location.href='/';throw Error('Увійдіть, щоб продовжити')}
    if(!response.ok)throw Error(data.error||'Не вдалося виконати дію')
    return data
  }
  const statusClass=s=>'status--'+String(s).replaceAll(' ','-')
  async function loadIdeas(){
    list.innerHTML='<div class="loading">Оновлюємо дошку…</div>'
    const p=new URLSearchParams({sort:$('#sortFilter').value})
    if($('#search').value.trim())p.set('q',$('#search').value.trim())
    if($('#categoryFilter').value)p.set('category',$('#categoryFilter').value)
    if($('#statusFilter').value)p.set('status',$('#statusFilter').value)
    if($('#mineFilter').checked)p.set('mine','true')
    try{
      const data=await api('/api/ideas?'+p.toString());ideas=data.ideas;categories=data.categories;statuses=data.statuses;staff=data.staff
      fillFilters();renderIdeas();
      $('#statTotal').textContent=data.summary.total;$('#statReview').textContent=data.summary.reviewing;$('#statActive').textContent=data.summary.active;$('#statDone').textContent=data.summary.completed
    }catch(error){list.innerHTML=`<div class="empty">${esc(error.message)}</div>`}
  }
  function fillFilters(){
    const cat=$('#categoryFilter'),st=$('#statusFilter'),oldCat=cat.value,oldSt=st.value
    if(cat.options.length===1)categories.forEach(c=>cat.add(new Option(c,c)))
    if(st.options.length===1)statuses.forEach(s=>st.add(new Option(s,s)))
    if(oldCat)cat.value=oldCat;if(oldSt)st.value=oldSt
    const sel=$('[name=category]');if(sel.options.length===0)categories.forEach(c=>sel.add(new Option(c,c)))
  }
  function renderIdeas(){
    if(!ideas.length){list.innerHTML='<div class="empty"><b>Тут ще немає ідей</b>Станьте першими: поділіться тим, що допоможе зробити університет кращим.</div>';return}
    list.innerHTML=ideas.map(i=>`<article class="idea-card" data-open="${i.id}" tabindex="0" role="button" aria-label="Відкрити ідею ${esc(i.title)}"><div class="idea-top"><span class="category">${esc(i.category)}</span><span class="status ${statusClass(i.status)}">${esc(i.status)}</span></div><h3>${esc(i.title)}</h3><p class="idea-excerpt">${esc(i.problem)}</p><div class="idea-meta"><span class="author">${esc(i.author_name)}</span><span>·</span><span>${date(i.updated_at)}</span><span>· ${esc(i.audience)}</span><div class="idea-actions"><button class="pill-action ${i.has_voted?'voted':''}" data-vote="${i.id}" ${i.author_id===window.currentUserId?'disabled':''} title="Підтримати">${i.has_voted?'♥':'♡'} ${i.vote_count}</button><span class="pill-action">◷ ${i.comment_count}</span></div></div></article>`).join('')
  }
  $('#openForm').addEventListener('click',()=>{editingId=null;form.reset();$('#formError').textContent='';formDialog.showModal()})
  document.addEventListener('click',async e=>{
    if(e.target.closest('[data-close]')){e.target.closest('dialog').close();return}
    const vote=e.target.closest('[data-vote]')
    if(vote){e.stopPropagation();try{await api(`/api/ideas/${vote.dataset.vote}/vote`,{method:'POST'});await loadIdeas()}catch(err){showToast(err.message)}return}
    const card=e.target.closest('[data-open]');if(card)openDetail(card.dataset.open)
  })
  document.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-open]')){e.preventDefault();openDetail(e.target.dataset.open)}})
  form.addEventListener('submit',async e=>{
    e.preventDefault();$('#formError').textContent=''
    const fd=new FormData(form),payload={title:fd.get('title'),category:fd.get('category'),audience:fd.get('audience'),problem:fd.get('problem'),solution:fd.get('solution'),benefit:fd.get('benefit'),is_anonymous:fd.has('is_anonymous'),visibility:fd.has('visibility')?'staff':'public'}
    try{await api(editingId?`/api/ideas/${editingId}`:'/api/ideas',{method:editingId?'PUT':'POST',body:JSON.stringify(payload)});formDialog.close();showToast(editingId?'Зміни збережено':'Ідею надіслано — дякуємо!');$('#mineFilter').checked=true;editingId=null;await loadIdeas()}
    catch(err){$('#formError').textContent=err.message}
  })
  async function openDetail(id){
    currentId=id;$('#detailBody').innerHTML='<div class="loading">Loading деталі…</div>';detailDialog.showModal()
    try{
      const d=await api(`/api/ideas/${id}`),i=d.idea
      const comments=d.comments.map(c=>`<div class="comment"><strong>${esc(c.author_name)}</strong><time>${date(c.created_at)}</time><p>${esc(c.content)}</p></div>`).join('')||'<p class="privacy-help">Коментарів ще немає — почніть обговорення.</p>'
      const history=d.history.map(h=>`<div class="comment"><strong>${esc(h.actor_name)} · ${esc(h.from_status)} → ${esc(h.to_status)}</strong><time>${date(h.created_at)}</time>${h.note?`<p>${esc(h.note)}</p>`:''}</div>`).join('')
      const mine=Number(i.author_id)===Number(window.currentUserId)
      $('#detailBody').innerHTML=`<p class="eyebrow">${esc(i.category)} · ДЛЯ ${esc(i.audience).toUpperCase()}</p><h2>${esc(i.title)}</h2><div><span class="status ${statusClass(i.status)}">${esc(i.status)}</span> <span class="privacy-help">${i.visibility==='staff'?'🔒 Приватна ідея':'🌐 Спільна дошка'} · ${esc(i.author_name)} · ${date(i.created_at)}</span></div><div class="detail-section detail-body"><b>Проблема</b>${esc(i.problem)}</div><div class="detail-section detail-body"><b>Запропоноване рішення</b>${esc(i.solution)}</div>${i.benefit?`<div class="detail-section detail-body"><b>Очікувана користь</b>${esc(i.benefit)}</div>`:''}${i.status_note?`<div class="privacy-note"><b>Відповідь команди</b><br>${esc(i.status_note)}</div>`:''}<div class="detail-footer"><button class="primary" data-detail-vote="${i.id}" ${mine?'disabled':''}>${d.votes.has_voted?'♥ Підтримано':'♡ Підтримати'} · ${d.votes.votes}</button><span class="privacy-help">Адресат: ${esc(i.audience)}</span>${d.can_edit?`<button class="pill-action" data-edit="${i.id}">Редагувати</button><button class="pill-action" data-delete="${i.id}">Видалити</button>`:''}</div>${d.staff?`<div class="manager"><b>Розгляд і відповідь</b><label>Статус<select id="managerStatus">${statuses.map(s=>`<option ${s===i.status?'selected':''}>${esc(s)}</option>`).join('')}</select></label><label>Коментар для автора / наступний крок<textarea id="managerNote" maxlength="1000" rows="2" placeholder="Додайте офіційну відповідь або пояснення">${esc(i.status_note||'')}</textarea></label><button class="primary" data-save-status="${i.id}">Зберегти рішення</button></div>`:''}<div class="comments"><b>Обговорення · ${d.comments.length}</b>${comments}<form class="comment-form" id="commentForm"><input name="content" maxlength="1000" required placeholder="Додайте конструктивний коментар…"><button>Надіслати</button></form></div>${history?`<div class="comments"><b>Історія рішень</b>${history}</div>`:''}`
    }catch(err){$('#detailBody').innerHTML=`<div class="empty">${esc(err.message)}</div>`}
  }
  document.addEventListener('click',async e=>{
    const vote=e.target.closest('[data-detail-vote]');if(vote){try{await api(`/api/ideas/${vote.dataset.detailVote}/vote`,{method:'POST'});await openDetail(currentId);await loadIdeas()}catch(err){showToast(err.message)}return}
    const save=e.target.closest('[data-save-status]');if(save){try{await api(`/api/ideas/${save.dataset.saveStatus}/status`,{method:'PATCH',body:JSON.stringify({status:$('#managerStatus').value,note:$('#managerNote').value})});showToast('Статус і відповідь оновлено');await openDetail(currentId);await loadIdeas()}catch(err){showToast(err.message)}return}
    const edit=e.target.closest('[data-edit]');if(edit){try{const data=await api(`/api/ideas/${edit.dataset.edit}`),i=data.idea;editingId=i.id;form.reset();form.elements.title.value=i.title;form.elements.category.value=i.category;form.elements.audience.value=i.audience;form.elements.problem.value=i.problem;form.elements.solution.value=i.solution;form.elements.benefit.value=i.benefit||'';$('#formError').textContent='';detailDialog.close();formDialog.showModal()}catch(err){showToast(err.message)}return}
    const del=e.target.closest('[data-delete]');if(del){try{await api(`/api/ideas/${del.dataset.delete}`,{method:'DELETE'});detailDialog.close();showToast('Ідею видалено');await loadIdeas()}catch(err){showToast(err.message)}return}
  })
  document.addEventListener('submit',async e=>{if(e.target.id!=='commentForm')return;e.preventDefault();const content=new FormData(e.target).get('content');try{await api(`/api/ideas/${currentId}/comments`,{method:'POST',body:JSON.stringify({content})});await openDetail(currentId);await loadIdeas()}catch(err){showToast(err.message)}})
  let searchTimer;$('#search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(loadIdeas,280)})
  ['categoryFilter','statusFilter','sortFilter','mineFilter'].forEach(id=>$('#'+id).addEventListener('change',loadIdeas))
  api('/api/me').then(me=>{window.currentUserId=Number(me.user?.id||me.id);loadIdeas()}).catch(()=>loadIdeas())
})()
