// Pane Renderers — person, company, and miyagi renderers for right pane

const PANE_RENDERERS = {};

function registerPaneRenderer(type, renderFn) {
  PANE_RENDERERS[type] = renderFn;
}

async function renderPaneContent(type, id, container) {
  container.classList.remove('llm-chat-layout');
  const renderer = PANE_RENDERERS[type];
  if (!renderer) {
    container.innerHTML = `<div class="llm-empty">No renderer for type "${esc(type)}"</div>`;
    return;
  }
  try { await renderer(container, id); }
  catch (err) {
    console.error('[pane-renderer]', type, err);
    container.innerHTML = `<div class="llm-empty">Couldn\u2019t load this ${esc(type)}. <button type="button" onclick="renderPaneContent('${esc(type)}','${esc(id)}',this.closest('.right-pane-content')||document.getElementById('rightPaneContent'))" style="background:none;border:none;color:var(--accent);cursor:pointer;font:inherit;text-decoration:underline">Retry</button></div>`;
  }
}

// === Person Renderer (Network) ===
registerPaneRenderer('person', async (container, id) => {
  container.innerHTML = '<div class="llm-empty">Loading person...</div>';
  const shortId = (id || '').replace(/-/g, '').slice(0, 8);
  const [data, contentData] = await Promise.all([
    fetchJSON(`/api/network/people/${id}`),
    fetchJSON(`/api/content/people/${shortId}`).catch(() => null),
  ]);
  if (!data || data.error) { container.innerHTML = '<div class="llm-empty">Person not found</div>'; return; }

  const tierLabels = {
    core: 'Core', network: 'Network', extended: 'Extended', acquaintance: 'Acquaintance',
    partners: 'Partners', collaborators: 'Collaborators',
  };
  const typeIcons = { email: 'mail', phone: 'phone', linkedin_url: 'link', name: 'badge' };

  let html = '<div class="net-detail">';

  const yearsStr = data.years_known != null ? (data.years_known >= 1 ? Math.round(data.years_known) + ' years' : '<1 year') : '';

  // Ontology class badge (people.yaml primary_class + subcategory) — algorithmic, never a manual override
  const klass = data.ontology_class || data.class || null;
  const subcat = data.ontology_subcategory || data.subcategory || null;
  const conf = data.ontology_confidence ?? data.class_confidence ?? null;
  const sourcesJson = data.ontology_sources || data.class_sources || '[]';
  let sourcesList = [];
  try { sourcesList = JSON.parse(sourcesJson || '[]'); } catch {}
  const classLabels = { business: 'Professionals', personal: 'Personal', mixed: 'Mixed' };
  const confColor = conf == null ? '#999' : conf >= 0.8 ? '#2e7d32' : conf >= 0.5 ? '#f9a825' : '#c62828';
  const confPct = conf != null ? Math.round(conf * 100) + '%' : 'n/a';
  const tooltip = sourcesList.length ? `Signals: ${sourcesList.join(', ')} · Confidence: ${confPct}` : `Confidence: ${confPct}`;
  const classBadge = klass
    ? `<span class="net-class-badge net-class-${klass}" title="${esc(tooltip)}">
         <span class="net-conf-dot" style="background:${confColor}"></span>
         ${esc(classLabels[klass])}${subcat ? ' · ' + esc(subcat.replace(/_/g, ' ')) : ''}
       </span>`
    : '<span class="net-class-badge" title="Unclassified — insufficient signal">Unclassified</span>';

  html += `<div class="net-detail-header">
    <div class="net-detail-avatar"><span class="material-symbols-outlined">person</span></div>
    <div>
      <div class="net-detail-name">${esc(data.display_name)}</div>
      <div class="net-detail-company">${classBadge} &middot; ${esc(tierLabels[data.tier] || data.tier || '')}${yearsStr ? ' &middot; Known ' + yearsStr : ''}</div>
    </div>
  </div>
  <button class="net-context-btn" onclick="openEntityChat('person','${esc(id)}','${esc(data.display_name)}')">
    <span class="material-symbols-outlined">chat</span> See context
  </button>`;

  // Identifiers
  html += '<div class="net-detail-section"><div class="net-detail-section-title">Contact Info</div><div class="net-ids">';
  if (data.identifiers?.length) {
    for (const ident of data.identifiers.slice(0, 15)) {
      const canEdit = ['email', 'phone', 'linkedin_url'].includes(ident.type);
      const inactiveClass = ident.active === false ? ' net-id-inactive' : '';
      const labelTag = ident.label ? `<span class="net-id-label">${esc(ident.label)}</span>` : '';
      const editBtn = canEdit
        ? `<span class="material-symbols-outlined net-id-edit" onclick="event.stopPropagation();editIdentifier('${esc(id)}',${ident.id},'${esc(ident.value)}')" title="Edit">edit</span>`
        : '';
      const detachBtn = canEdit
        ? `<span class="material-symbols-outlined net-id-detach" onclick="event.stopPropagation();detachIdentifier('${esc(id)}',${ident.id})" title="Detach">close</span>`
        : '';
      html += `<div class="net-id-row${inactiveClass}">
        <span class="material-symbols-outlined">${typeIcons[ident.type] || 'tag'}</span>
        <span class="net-id-value">${esc(ident.value)}</span>
        ${labelTag}${editBtn}${detachBtn}
      </div>`;
    }
  }
  html += `<div class="net-id-row net-id-add" onclick="addIdentifier('${esc(id)}')">
    <span class="material-symbols-outlined">add</span>
    <span style="font-size:12px;color:var(--muted)">Add email, phone, or LinkedIn</span>
  </div>`;
  html += '</div></div>';

  // Settings — classification is algorithmic (no manual override). Only existence flags here.
  html += '<div class="net-detail-section"><div class="net-detail-section-title">Settings</div>';
  html += `<div class="net-setting-row"><button class="net-action-btn" onclick="setPersonField('${esc(id)}','archived',${data.archived ? 0 : 1})">${data.archived ? 'Unarchive' : 'Archive'}</button></div>`;
  html += '</div>';

  // Profile — context file content (About section from /api/content/people)
  if (contentData?.body) {
    const body = contentData.body.replace(/^---[\s\S]*?---\n?/, '').trim();
    const sections = body.split(/\n## /);
    const aboutRaw = sections.find(s => s.startsWith('About\n')) || '';
    const aboutText = aboutRaw.replace(/^About\n/, '').trim();
    if (aboutText) {
      const lines = aboutText.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        if (/^#/.test(trimmed)) return null; // skip name heading
        const isHeader = /^\*\*[^*]+\*\*$/.test(trimmed); // **Role** pattern — standalone header
        if (isHeader) {
          const label = trimmed.replace(/\*\*/g, '');
          return `<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:8px;margin-bottom:2px">${esc(label)}</div>`;
        }
        const escaped = esc(trimmed).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        return `<div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:3px">${escaped}</div>`;
      }).filter(Boolean);
      if (lines.length) {
        html += `<div class="net-detail-section"><div class="net-detail-section-title">Profile</div>${lines.join('')}</div>`;
      }
    }
  }

  // Actions
  html += `<div class="net-actions">
    <button class="net-action-btn" onclick="editPerson('${esc(id)}')"><span class="material-symbols-outlined">edit</span> Name</button>
    <button class="net-action-btn" onclick="mergePerson('${esc(id)}')"><span class="material-symbols-outlined">merge</span> Merge</button>
  </div>`;

  html += '</div>';
  container.innerHTML = html;
});

// === Company Renderer (Network) ===
registerPaneRenderer('company', async (container, id) => {
  container.innerHTML = '<div class="llm-empty">Loading company...</div>';
  // Mirror the person renderer: fetch the company card and its context/research
  // file in parallel. The content route (/api/content/companies/:shortId) is
  // already live; a company with no context_file_path returns a null body and
  // the Research section is simply omitted (no broken empty state).
  const shortId = (id || '').replace(/-/g, '').slice(0, 8);
  const [data, contentData] = await Promise.all([
    fetchJSON(`/api/network/companies/${id}`),
    fetchJSON(`/api/content/companies/${shortId}`).catch(() => null),
  ]);
  if (!data || data.error) { container.innerHTML = '<div class="llm-empty">Company not found</div>'; return; }

  let html = '<div class="net-detail">';
  html += `<div class="net-detail-header">
    <div class="net-detail-avatar"><span class="material-symbols-outlined">business</span></div>
    <div>
      <div class="net-detail-name">${esc(data.name)}</div>
      <div class="net-detail-company">${esc((data.domains || []).slice(0, 3).join(', '))}</div>
    </div>
  </div>
  <button class="net-context-btn" onclick="openEntityChat('company','${esc(id)}','${esc(data.name)}')">
    <span class="material-symbols-outlined">chat</span> See context
  </button>`;

  if (data.domains?.length) {
    html += '<div class="net-detail-section"><div class="net-detail-section-title">Websites</div><div class="net-ids">';
    for (const d of data.domains) {
      html += `<div class="net-id-row">
        <span class="material-symbols-outlined">language</span>
        <a href="https://${esc(d)}" target="_blank" rel="noopener" class="net-id-value" style="color:var(--accent);text-decoration:none">${esc(d)}</a>
      </div>`;
    }
    html += '</div></div>';
  }

  if (data.people?.length) {
    html += `<div class="net-detail-section"><div class="net-detail-section-title">People (${data.people.length})</div><div class="net-ids">`;
    for (const p of data.people.slice(0, 15)) {
      html += `<div class="net-id-row" style="cursor:pointer" onclick="selectPerson && selectPerson('${esc(p.id)}')">
        <span class="material-symbols-outlined">person</span>
        <span class="net-id-value" style="font-family:var(--font)">${esc(p.display_name)}</span>
        <span style="font-size:10px;color:var(--muted)">${esc(p.tier || '')}</span>
      </div>`;
    }
    html += '</div></div>';
  }

  // Connections — typed relationship edges recorded via add-relationship CLI or
  // the backfill script. Filter out the company itself so it doesn't appear
  // as a connection to itself (can happen when entity_id_a === id).
  // Each entry shows: the other entity's display name, its type, and the
  // relationship type label.
  if (data.connections?.length) {
    // Only show connections where the other side is not this company.
    const otherConnections = data.connections.filter(
      edge => !(edge.entity_id_a === id && edge.entity_id_b === id),
    ).map(edge => {
      // Determine which side is "the other" entity.
      const isA = String(edge.entity_id_a) === String(id);
      return {
        otherId:      isA ? edge.entity_id_b   : edge.entity_id_a,
        otherType:    isA ? edge.entity_type_b  : edge.entity_type_a,
        otherName:    isA ? edge.display_name_b : edge.display_name_a,
        relType:      edge.relationship_type,
      };
    }).filter(c => c.otherId !== String(id)); // belt-and-suspenders dedupe

    if (otherConnections.length) {
      const typeIcons = {
        person: 'person',
        company: 'business',
        place: 'place',
      };
      // Human-readable labels for relationship types.
      const relLabels = {
        'invested-in':  'Investor',
        'board-member': 'Board member',
        'advisor':      'Advisor',
        'founder':      'Founder',
        'employee':     'Employee',
      };
      html += `<div class="net-detail-section"><div class="net-detail-section-title">Connections (${otherConnections.length})</div><div class="net-ids">`;
      for (const conn of otherConnections.slice(0, 30)) {
        const icon = typeIcons[conn.otherType] || 'link';
        const relLabel = relLabels[conn.relType] || conn.relType;
        html += `<div class="net-id-row">
          <span class="material-symbols-outlined">${icon}</span>
          <span class="net-id-value">${esc(conn.otherName || conn.otherId)}</span>
          <span style="font-size:10px;color:var(--muted)">${esc(relLabel)}</span>
        </div>`;
      }
      html += '</div></div>';
    }
  }

  // Research — the company's context/research file (from promoted workbench
  // research + regen), mirroring the person renderer's Profile section. Guarded
  // by contentData?.body so a company with no research shows no section.
  if (contentData?.body) {
    const body = contentData.body.replace(/^---[\s\S]*?---\n?/, '').trim();
    const lines = body.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      if (/^#\s/.test(trimmed)) return null; // skip the top name heading
      const heading = trimmed.match(/^#{2,}\s+(.*)$/);
      if (heading) {
        return `<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-top:8px;margin-bottom:2px">${esc(heading[1])}</div>`;
      }
      const escaped = esc(trimmed.replace(/^[-*]\s+/, '')).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      return `<div style="font-size:13px;color:var(--text);line-height:1.5;margin-bottom:3px">${escaped}</div>`;
    }).filter(Boolean);
    if (lines.length) {
      html += `<div class="net-detail-section"><div class="net-detail-section-title">Research</div>${lines.join('')}</div>`;
    }
  }

  html += '</div>';
  container.innerHTML = html;
});

// === Miyagi (LLM Chat) Renderer ===
registerPaneRenderer('miyagi', async (container, id) => {
  container.classList.add('llm-chat-layout');
  container.innerHTML = `
    <div class="llm-messages" id="rightPaneLlmMessages"></div>
    <div class="llm-input-wrap">
      <div class="llm-input-area">
        <button class="llm-attach-btn" onclick="document.getElementById('rightPaneLlmFile').click()" title="Attach file"><span class="material-symbols-outlined">attach_file</span></button>
        <textarea id="rightPaneLlmInput" rows="1" placeholder="Ask Miyagi..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendRightPaneLlm()}"></textarea>
        <button onclick="sendRightPaneLlm()" title="Send"><span class="material-symbols-outlined">send</span></button>
      </div>
      <input type="file" id="rightPaneLlmFile" hidden multiple>
    </div>`;
  const ta = $('#rightPaneLlmInput');
  if (ta) autoGrowTextarea(ta);
});

let rightPaneLlmMessages = [];

async function sendRightPaneLlm() {
  const input = $('#rightPaneLlmInput');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (typeof autoGrowTextarea === 'function') autoGrowTextarea(input);

  rightPaneLlmMessages.push({ role: 'user', content: text });
  const msgsEl = $('#rightPaneLlmMessages');
  if (!msgsEl) return;

  const userDiv = document.createElement('div');
  userDiv.className = 'llm-msg user';
  userDiv.textContent = text;
  msgsEl.querySelector('.llm-empty')?.remove();
  msgsEl.appendChild(userDiv);

  const replyDiv = document.createElement('div');
  replyDiv.className = 'llm-msg assistant';
  msgsEl.appendChild(replyDiv);
  msgsEl.scrollTop = msgsEl.scrollHeight;

  try {
    const ctx = window.robotdojoContext || {};
    const appName = window.location.pathname.split('/')[1] || 'general';
    const body = {
      messages: rightPaneLlmMessages,
      model: (window.location.pathname.includes('/health') || ctx.type === 'health') ? 'claude-opus' : 'claude-sonnet',
      context: ctx.type || appName,
    };
    if (ctx.title) body.injectedContext = `Current context: ${ctx.type} — "${ctx.title}"`;
    const content = await streamLlmResponse(replyDiv, msgsEl, body);
    rightPaneLlmMessages.push({ role: 'assistant', content });
  } catch (err) {
    console.error('[pane-chat]', err);
    replyDiv.textContent = 'Something went wrong. Please try again.';
  }
}

// --- Entity Chat ---
function openEntityChat(type, id, name) {
  const params = new URLSearchParams({ entity_type: type, entity_id: id, prompt: `Tell me about ${name}`, autosend: 'true' });
  window.open(`/chat?${params}`, '_blank');
}

// === Place Renderer (Network Places) ===
registerPaneRenderer('place', async (container, id) => {
  container.innerHTML = '<div class="llm-empty">Loading place...</div>';
  const data = await fetchJSON(`/api/network/places/${id}`).catch(() => null);
  if (!data) { container.innerHTML = '<div class="llm-empty">Place not found</div>'; return; }
  const p = data.place || data;
  const ptDef = (typeof PLACE_TYPES !== 'undefined' ? PLACE_TYPES : []).find(v => v.key === p.place_subtype);
  const icon = ptDef?.icon || 'place';

  let html = `<div class="net-detail">
    <div class="net-detail-header">
      <div class="net-detail-avatar"><span class="material-symbols-outlined">${icon}</span></div>
      <div>
        <div class="net-detail-name">${esc(p.name)}</div>
        <div class="net-detail-meta">${esc(ptDef?.label || p.place_subtype || '')}</div>
      </div>
    </div>
    <button class="net-context-btn" onclick="openEntityChat('place','${esc(id)}','${esc(p.name)}')">
      <span class="material-symbols-outlined">chat</span> See context
    </button>`;

  if (data.events?.length) {
    html += '<div class="net-detail-section"><div class="net-detail-section-title">Recent visits</div>';
    for (const e of data.events.slice(0, 15)) {
      html += `<div class="net-detail-row">
        <span class="net-meta">${formatAge(e.event_date || e.created_at)}</span>
        ${esc(e.title || e.event_type || '')}
      </div>`;
    }
    html += '</div>';
  }

  if (data.people?.length) {
    html += `<div class="net-detail-section"><div class="net-detail-section-title">People (${data.people.length})</div>`;
    for (const person of data.people.slice(0, 10)) {
      html += `<div class="net-detail-row" style="cursor:pointer" onclick="selectPerson && selectPerson('${esc(person.id || '')}')">
        <span class="material-symbols-outlined" style="font-size:14px;color:var(--muted)">person</span>
        ${esc(person.display_name || person.name || '')}
      </div>`;
    }
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
});
