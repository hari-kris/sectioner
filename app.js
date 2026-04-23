/* ================================================================
   1. STATE
   ================================================================ */

const state = {
  apiKey: '',
  prompt: '',
  sections: [],
  constraints: {
    tone: '',
    audience: '',
    maxLength: null,
    customRule: ''
  },
  activeSection: null,
  docGenerated: false
};

const MAX_HISTORY = 3;
const MODEL = 'claude-sonnet-4-20250514';
const API_URL = '/api/messages';

const PROMPT_CHIPS = [
  { label: 'PRD — expense tracker',  prompt: 'Write a product requirements document for a mobile expense tracker app targeting small business owners' },
  { label: 'GTM strategy',            prompt: 'Write a go-to-market strategy document for a new B2B SaaS productivity tool' },
  { label: 'QBR document',            prompt: 'Write a quarterly business review document for a software company with sections for performance, wins, challenges, and next quarter goals' },
  { label: 'Tech architecture',       prompt: 'Write a technical architecture document for a cloud-based web application with sections covering system design, data flow, security, and scalability' },
];

/* ================================================================
   2. SYSTEM PROMPTS
   ================================================================ */

const PROMPT_GENERATION = `You are a professional document writer. When given a topic or prompt, generate a well-structured document with clear sections using ## markdown headings. Each section should have a descriptive heading and substantive content. Do not include a table of contents. Return only the document content in markdown format.`;

function buildEditPrompt(constraints, fullDoc, sectionName, sectionContent, instruction) {
  const tone       = constraints.tone       || 'none';
  const audience   = constraints.audience   || 'none';
  const maxLength  = constraints.maxLength  ? `${constraints.maxLength} words` : 'none';
  const customRule = constraints.customRule || 'none';

  return `You are editing a specific section of a larger document.

The full document context is provided for coherence, but you must return ONLY the updated content for the target section — no headings, no preamble, no explanation.

Active constraints:
- Tone: ${tone}
- Audience: ${audience}
- Max length: ${maxLength}
- Custom rules: ${customRule}

Full document:
${fullDoc}

Section to edit: ${sectionName}
Current section content:
${sectionContent}

User instruction: ${instruction}

Return only the updated section content. Do not include the section heading.`;
}

function buildConsistencyPrompt(fullDoc) {
  return `Review the following document and identify:
1. Direct contradictions between sections
2. Terminology inconsistencies (the same concept referred to by different names)
3. Sections whose content no longer matches what the introduction or summary promises

Return a JSON array with this exact structure:
[
  {
    "issue_type": "contradiction",
    "sections_involved": ["Section Name 1", "Section Name 2"],
    "description": "Plain English description of the issue"
  }
]

Valid issue_type values: "contradiction", "terminology", "mismatch"

If no issues are found, return an empty array: []

Do not include any text outside the JSON array.

Document:
${fullDoc}`;
}

/* ================================================================
   3. UTILITIES
   ================================================================ */

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Minimal markdown → HTML: covers ##/### headings, bold, italic, code, lists, paragraphs
function markdownToHtml(md) {
  if (!md) return '';
  let h = escapeHtml(md);

  h = h.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');

  h = h.replace(/(^- .+(\n- .+)*)/gm, block => {
    const items = block.split('\n').map(l => `<li>${l.replace(/^-\s+/, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  h = h.replace(/(^\d+\. .+(\n\d+\. .+)*)/gm, block => {
    const items = block.split('\n').map(l => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  h = h.split(/\n{2,}/).map(block => {
    block = block.trim();
    if (!block) return '';
    if (/^<(h[1-6]|ul|ol)/.test(block)) return block;
    return `<p>${block.replace(/\n/g, ' ')}</p>`;
  }).filter(Boolean).join('\n');

  return h;
}

function stripHeadingIfPresent(content, heading) {
  const lines = content.split('\n');
  const first = lines[0].trim();
  if (new RegExp(`^#{1,3}\\s+${escapeRegex(heading)}\\s*$`, 'i').test(first)) {
    return lines.slice(1).join('\n').trim();
  }
  return content.trim();
}

/* ================================================================
   4. SECTION PARSING
   ================================================================ */

function parseMarkdownToSections(markdown) {
  const parts = markdown.split(/\n(?=#{2,3} )/).map(p => p.trim()).filter(Boolean);

  const sections = parts.map(part => {
    const lines = part.split('\n');
    const match = lines[0].match(/^(#{2,3})\s+(.+)$/);
    if (!match) {
      return { id: generateId(), heading: 'Document', content: part.trim(), status: 'draft', history: [] };
    }
    return {
      id: generateId(),
      heading: match[2].trim(),
      content: lines.slice(1).join('\n').trim(),
      status: 'draft',
      history: []
    };
  }).filter(s => s.heading || s.content);

  if (sections.length === 0) {
    return [{ id: generateId(), heading: 'Document', content: markdown.trim(), status: 'draft', history: [] }];
  }

  return sections;
}

function buildFullDocument() {
  return state.sections.map(s => `## ${s.heading}\n\n${s.content}`).join('\n\n');
}

/* ================================================================
   5. LCS WORD DIFF
   ================================================================ */

function tokenizeWords(text) {
  return text.split(/(\s+)/);
}

function lcsMatrix(a, b) {
  const m = a.length, n = b.length;
  const dp = new Int16Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i-1] === b[j-1]) {
        dp[i*(n+1)+j] = dp[(i-1)*(n+1)+(j-1)] + 1;
      } else {
        const top = dp[(i-1)*(n+1)+j], left = dp[i*(n+1)+(j-1)];
        dp[i*(n+1)+j] = top > left ? top : left;
      }
    }
  }
  return { dp, m, n };
}

function diffOps(a, b, { dp, m, n }) {
  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      result.push({ op: 'equal',  value: a[i-1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i*(n+1)+(j-1)] >= dp[(i-1)*(n+1)+j])) {
      result.push({ op: 'insert', value: b[j-1] }); j--;
    } else {
      result.push({ op: 'delete', value: a[i-1] }); i--;
    }
  }
  return result.reverse();
}

function renderDiff(oldText, newText) {
  const a = tokenizeWords(oldText), b = tokenizeWords(newText);
  const ops = diffOps(a, b, lcsMatrix(a, b));
  return ops.map(op => {
    const safe = escapeHtml(op.value);
    if (op.op === 'equal')  return safe;
    if (op.op === 'delete') return `<span class="diff-removed">${safe}</span>`;
    if (op.op === 'insert') return `<span class="diff-added">${safe}</span>`;
    return safe;
  }).join('');
}

/* ================================================================
   6. RENDER ENGINE
   ================================================================ */

function renderSidebar() {
  const list = document.getElementById('section-list');
  const emptyState = document.getElementById('sidebar-empty-state');

  if (state.sections.length === 0) {
    if (!emptyState) {
      list.innerHTML = '<div id="sidebar-empty-state" class="sidebar-empty"><div class="sidebar-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div><p>Generate a document to see sections here</p></div>';
    }
    return;
  }

  list.innerHTML = '';
  state.sections.forEach(section => {
    const item = document.createElement('div');
    item.className = 'section-item';
    item.dataset.id = section.id;
    if (section.status === 'locked') item.classList.add('locked');
    if (section.id === state.activeSection) item.classList.add('active');

    const left = document.createElement('div');
    left.className = 'section-item-left';

    const label = document.createElement('span');
    label.className = 'section-heading-label';
    label.textContent = section.heading;
    label.title = section.heading;

    const badge = document.createElement('span');
    badge.className = `status-badge status-${section.status}`;
    badge.textContent = section.status;

    left.appendChild(label);
    left.appendChild(badge);

    const lockBtn = document.createElement('button');
    lockBtn.className = 'lock-btn';
    lockBtn.title = section.status === 'locked' ? 'Unlock section' : 'Lock section';
    lockBtn.textContent = section.status === 'locked' ? '🔒' : '🔓';
    lockBtn.dataset.id = section.id;

    item.appendChild(left);
    item.appendChild(lockBtn);

    left.addEventListener('click', () => openEditPanel(section.id));
    lockBtn.addEventListener('click', e => { e.stopPropagation(); toggleSectionLock(section.id); });

    list.appendChild(item);
  });

  updateConstraintsBadge();
}

function renderDocumentView() {
  const content = document.getElementById('document-content');
  content.innerHTML = '';
  state.sections.forEach(section => content.appendChild(createSectionBlock(section)));
}

function createSectionBlock(section) {
  const block = document.createElement('div');
  block.className = 'section-block';
  block.id = `block-${section.id}`;
  block.dataset.id = section.id;
  if (section.id === state.activeSection) block.classList.add('active');

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = section.heading;

  const body = document.createElement('div');
  body.className = 'section-body';
  body.innerHTML = markdownToHtml(section.content);

  block.appendChild(heading);
  block.appendChild(body);
  block.addEventListener('click', () => { if (section.status !== 'locked') openEditPanel(section.id); });
  return block;
}

function renderSectionBlock(sectionId) {
  const section = getSectionById(sectionId);
  const existing = document.getElementById(`block-${sectionId}`);
  if (!section || !existing) return;
  existing.replaceWith(createSectionBlock(section));
}

function applyDiffToBlock(sectionId, oldContent, newContent) {
  const block = document.getElementById(`block-${sectionId}`);
  if (!block) return;

  const body = block.querySelector('.section-body');
  if (body) body.innerHTML = renderDiff(oldContent, newContent);
  block.classList.add('diff-active');

  const prev = block.querySelector('.diff-actions');
  if (prev) prev.remove();

  const bar = document.createElement('div');
  bar.className = 'diff-actions';

  const lbl = document.createElement('span');
  lbl.className = 'diff-actions-label';
  lbl.textContent = 'Review changes';

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'btn-outlined';
  acceptBtn.style.padding = '4px 10px';
  acceptBtn.style.fontSize = '12px';
  acceptBtn.textContent = 'Accept';
  acceptBtn.addEventListener('click', e => { e.stopPropagation(); clearDiff(sectionId); });

  const undoBtn = document.createElement('button');
  undoBtn.className = 'btn-outlined';
  undoBtn.style.padding = '4px 10px';
  undoBtn.style.fontSize = '12px';
  undoBtn.textContent = 'Undo';
  undoBtn.addEventListener('click', e => { e.stopPropagation(); undoSection(sectionId); });

  bar.appendChild(lbl);
  bar.appendChild(acceptBtn);
  bar.appendChild(undoBtn);
  block.appendChild(bar);
}

function clearDiff(sectionId) {
  const section = getSectionById(sectionId);
  const block = document.getElementById(`block-${sectionId}`);
  if (!block) return;
  const body = block.querySelector('.section-body');
  if (body && section) body.innerHTML = markdownToHtml(section.content);
  block.classList.remove('diff-active');
  const bar = block.querySelector('.diff-actions');
  if (bar) bar.remove();
}

function dimAllExcept(sectionId) {
  document.querySelectorAll('.section-block').forEach(b => b.classList.toggle('dimmed', b.dataset.id !== sectionId));
  document.querySelectorAll('.section-item').forEach(i => i.classList.toggle('dimmed', i.dataset.id !== sectionId));
}

function undimAll() {
  document.querySelectorAll('.section-block, .section-item').forEach(el => el.classList.remove('dimmed'));
}

function scrollToBlock(sectionId) {
  const block = document.getElementById(`block-${sectionId}`);
  if (block) block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ================================================================
   7. EDIT PANEL CONTROLLER
   ================================================================ */

function openEditPanel(sectionId) {
  const section = getSectionById(sectionId);
  if (!section) return;
  if (section.status === 'locked') { showToast('This section is locked.', 'warning'); return; }

  if (state.activeSection && state.activeSection !== sectionId) {
    clearDiff(state.activeSection);
  }

  state.activeSection = sectionId;

  document.getElementById('edit-section-title').textContent   = section.heading;
  document.getElementById('edit-section-content').innerHTML   = markdownToHtml(section.content);
  document.getElementById('edit-instruction').value           = '';
  document.getElementById('edit-error').classList.add('hidden');
  document.getElementById('btn-submit-edit').disabled         = true;

  updateUndoButton(sectionId);
  updateConstraintsSummary();

  // Show edit content, hide empty state
  document.getElementById('edit-panel-empty').classList.add('hidden');
  document.getElementById('edit-panel-content').classList.remove('hidden');

  renderSidebar();
  document.querySelectorAll('.section-block').forEach(b => b.classList.toggle('active', b.dataset.id === sectionId));
  dimAllExcept(sectionId);
  scrollToBlock(sectionId);

  requestAnimationFrame(() => document.getElementById('edit-instruction').focus());
}

function closeEditPanel() {
  if (state.activeSection) clearDiff(state.activeSection);
  state.activeSection = null;

  document.getElementById('edit-panel-content').classList.add('hidden');
  document.getElementById('edit-panel-empty').classList.remove('hidden');
  document.getElementById('edit-instruction').value = '';
  document.getElementById('edit-error').classList.add('hidden');

  undimAll();
  renderSidebar();
  document.querySelectorAll('.section-block').forEach(b => b.classList.remove('active'));
}

function refreshEditPanelContent(sectionId) {
  if (state.activeSection !== sectionId) return;
  const section = getSectionById(sectionId);
  if (!section) return;
  document.getElementById('edit-section-content').innerHTML = markdownToHtml(section.content);
  updateUndoButton(sectionId);
  updateConstraintsSummary();
}

function updateUndoButton(sectionId) {
  const section = getSectionById(sectionId);
  document.getElementById('btn-undo-edit').disabled = !section || section.history.length === 0;
}

function updateConstraintsSummary() {
  const el = document.getElementById('active-constraints-summary');
  const parts = [];
  if (state.constraints.tone)       parts.push(`Tone: <strong>${escapeHtml(state.constraints.tone)}</strong>`);
  if (state.constraints.audience)   parts.push(`For: <strong>${escapeHtml(state.constraints.audience)}</strong>`);
  if (state.constraints.maxLength)  parts.push(`Max: <strong>${state.constraints.maxLength}w</strong>`);
  if (state.constraints.customRule) parts.push(`Rule: <strong>${escapeHtml(state.constraints.customRule)}</strong>`);
  if (parts.length > 0) {
    el.innerHTML = parts.join(' &nbsp;·&nbsp; ');
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

/* ================================================================
   8. API CALLS
   ================================================================ */

async function callClaude({ systemPrompt, userMessage, apiKey }) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const status = response.status;
    if (status === 401) throw new Error('invalid_api_key');
    if (status === 429) throw new Error('rate_limited');
    throw new Error(`api_error_${status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function generateDocument(prompt, apiKey) {
  return callClaude({ systemPrompt: PROMPT_GENERATION, userMessage: prompt, apiKey });
}

async function editSection(section, instruction, apiKey) {
  const systemPrompt = buildEditPrompt(
    state.constraints, buildFullDocument(),
    section.heading, section.content, instruction
  );
  const result = await callClaude({ systemPrompt, userMessage: instruction, apiKey });
  return stripHeadingIfPresent(result, section.heading);
}

async function checkConsistency(fullDocument, apiKey) {
  const result = await callClaude({
    systemPrompt: buildConsistencyPrompt(fullDocument),
    userMessage: 'Return the JSON array of issues.',
    apiKey
  });

  const match = result.match(/\[[\s\S]*\]/);
  if (!match) { if (result.trim() === '[]') return []; throw new Error('malformed_json'); }

  try { return JSON.parse(match[0]); }
  catch { throw new Error('malformed_json'); }
}

/* ================================================================
   9. CONSTRAINTS
   ================================================================ */

function readConstraints() {
  state.constraints.tone       = document.getElementById('c-tone').value.trim();
  state.constraints.audience   = document.getElementById('c-audience').value.trim();
  const raw                    = document.getElementById('c-maxlength').value.trim();
  state.constraints.maxLength  = raw ? parseInt(raw, 10) : null;
  state.constraints.customRule = document.getElementById('c-custom').value.trim();
}

function countActiveConstraints() {
  readConstraints();
  return [state.constraints.tone, state.constraints.audience, state.constraints.maxLength, state.constraints.customRule]
    .filter(Boolean).length;
}

function updateConstraintsBadge() {
  const count = countActiveConstraints();
  const pill   = document.getElementById('btn-constraints-toggle');
  const label  = document.getElementById('constraints-count-label');
  label.textContent = `${count} constraint${count === 1 ? '' : 's'}`;
  pill.classList.toggle('has-constraints', count > 0);
}

/* ================================================================
   10. HISTORY & UNDO
   ================================================================ */

function pushHistory(sectionId, oldContent) {
  const s = getSectionById(sectionId);
  if (!s) return;
  s.history.unshift(oldContent);
  s.history.splice(MAX_HISTORY);
}

function undoSection(sectionId) {
  const s = getSectionById(sectionId);
  if (!s || s.history.length === 0) { showToast('Nothing to undo.', 'info'); return; }
  const prev = s.history.shift();
  if (!prev && prev !== '') { showToast('Cannot restore — previous state unavailable.', 'error'); return; }
  s.content = prev;
  clearDiff(sectionId);
  renderSectionBlock(sectionId);
  refreshEditPanelContent(sectionId);
  renderSidebar();
  if (state.activeSection === sectionId) {
    const block = document.getElementById(`block-${sectionId}`);
    if (block) { block.classList.add('active'); dimAllExcept(sectionId); }
  }
  showToast('Edit undone.', 'success');
}

/* ================================================================
   11. CONSISTENCY CHECK
   ================================================================ */

async function runConsistencyCheck() {
  if (state.sections.length === 0) { showToast('Generate a document first.', 'info'); return; }
  readConstraints();
  showLoading('Checking consistency…');
  try {
    const issues = await checkConsistency(buildFullDocument(), state.apiKey);
    hideLoading();
    renderConsistencyModal(issues);
  } catch (err) {
    hideLoading();
    if (err.message === 'malformed_json') renderConsistencyModal(null);
    else showToast(friendlyError(err), 'error');
  }
}

function renderConsistencyModal(issues) {
  const results = document.getElementById('consistency-results');
  const modal   = document.getElementById('modal-consistency');

  if (!issues) {
    results.innerHTML = '<p class="error-message">Could not parse consistency results. Try again.</p>';
  } else if (issues.length === 0) {
    results.innerHTML = '<p class="no-issues">✓ No consistency issues found.</p>';
  } else {
    results.innerHTML = '';
    issues.forEach(issue => {
      const el = document.createElement('div');
      el.className = 'consistency-issue';

      const badge = document.createElement('span');
      badge.className = `issue-type-badge issue-type-${issue.issue_type}`;
      badge.textContent = issue.issue_type;

      const secs = document.createElement('div');
      secs.className = 'issue-sections';
      secs.textContent = (issue.sections_involved || []).join(' · ');

      const desc = document.createElement('div');
      desc.className = 'issue-description';
      desc.textContent = issue.description;

      el.appendChild(badge);
      el.appendChild(secs);
      el.appendChild(desc);

      el.addEventListener('click', () => {
        closeModal();
        const name = (issue.sections_involved || [])[0];
        if (name) {
          const target = state.sections.find(s =>
            s.heading.toLowerCase().includes(name.toLowerCase()) ||
            name.toLowerCase().includes(s.heading.toLowerCase())
          );
          if (target) openEditPanel(target.id);
        }
      });

      results.appendChild(el);
    });
  }

  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-consistency').classList.add('hidden');
}

/* ================================================================
   12. EXPORT
   ================================================================ */

function exportToClipboard() {
  if (!state.sections.length) { showToast('Nothing to export yet.', 'info'); return; }
  const md = buildFullDocument();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(md)
      .then(() => showToast('Copied to clipboard.', 'success'))
      .catch(() => fallbackCopy(md));
  } else {
    fallbackCopy(md);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); showToast('Copied to clipboard.', 'success'); }
  catch { showToast('Could not copy. Try manually.', 'error'); }
  document.body.removeChild(ta);
}

function exportMarkdown() {
  if (!state.sections.length) { showToast('Nothing to export yet.', 'info'); return; }
  downloadFile(buildFullDocument(), 'sectioner-doc.md', 'text/markdown');
}

function exportText() {
  if (!state.sections.length) { showToast('Nothing to export yet.', 'info'); return; }
  downloadFile(stripMarkdownSyntax(buildFullDocument()), 'sectioner-doc.txt', 'text/plain');
}

function stripMarkdownSyntax(md) {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/^\d+\.\s+/gm, '')
    .trim();
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${filename}.`, 'success');
}

/* ================================================================
   13. TOAST & LOADING
   ================================================================ */

function showToast(message, type = 'info', durationMs = 3000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast${type !== 'info' ? ' ' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.parentNode && container.removeChild(toast), durationMs + 300);
}

function showLoading(message = 'Loading…') {
  document.getElementById('loading-message').textContent = message;
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function friendlyError(err) {
  const m = err.message || '';
  if (m === 'invalid_api_key')    return 'Invalid API key. Check your key and try again.';
  if (m === 'rate_limited')       return 'Rate limited — wait a moment and try again.';
  if (m.startsWith('api_error_')) return `API error (${m.replace('api_error_', '')}).`;
  if (m === 'malformed_json')     return 'Could not parse results. Try again.';
  if (m === 'Failed to fetch')    return 'Network error — check your connection.';
  return `Error: ${m}`;
}

/* ================================================================
   14. HELPERS
   ================================================================ */

function getSectionById(id) {
  return state.sections.find(s => s.id === id) || null;
}

function toggleSectionLock(sectionId) {
  const s = getSectionById(sectionId);
  if (!s) return;
  if (s.status === 'locked') {
    s.status = s.history.length > 0 ? 'edited' : 'draft';
    showToast(`"${s.heading}" unlocked.`, 'info');
  } else {
    if (state.activeSection === sectionId) closeEditPanel();
    s.status = 'locked';
    showToast(`"${s.heading}" locked.`, 'info');
  }
  renderSidebar();
}

function showFieldError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearFieldError(id) {
  const el = document.getElementById(id);
  el.textContent = '';
  el.classList.add('hidden');
}

function showEditError(msg) {
  const el = document.getElementById('edit-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearEditError() {
  const el = document.getElementById('edit-error');
  el.textContent = '';
  el.classList.add('hidden');
}

/* ================================================================
   15. EVENT WIRING
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {

  // --- LANDING SCREEN ---

  const landingKeyInput = document.getElementById('landing-api-key');
  const btnStart        = document.getElementById('btn-start-writing');
  const btnToggleKey    = document.getElementById('btn-toggle-key');

  const keyErrorEl = document.getElementById('landing-key-error');

  landingKeyInput.addEventListener('input', () => {
    const val = landingKeyInput.value.trim();
    const valid = val.length === 0 || val.startsWith('sk-ant-');
    keyErrorEl.classList.toggle('hidden', valid);
    btnStart.disabled = val.length === 0 || !valid;
  });

  btnToggleKey.addEventListener('click', () => {
    const isPassword = landingKeyInput.type === 'password';
    landingKeyInput.type = isPassword ? 'text' : 'password';
  });

  btnStart.addEventListener('click', () => {
    const key = landingKeyInput.value.trim();
    if (!key) return;
    state.apiKey = key;
    document.getElementById('landing-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
  });

  landingKeyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !btnStart.disabled) btnStart.click();
  });

  // --- CHANGE API KEY (from within the app) ---

  document.getElementById('btn-change-key').addEventListener('click', () => {
    state.apiKey = '';
    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('landing-screen').classList.remove('hidden');
    landingKeyInput.value = '';
    btnStart.disabled = true;
    setTimeout(() => landingKeyInput.focus(), 50);
  });

  // --- PROMPT CHIPS ---

  const chipsContainer = document.getElementById('prompt-chips');
  PROMPT_CHIPS.forEach(({ label, prompt }) => {
    const chip = document.createElement('button');
    chip.className = 'prompt-chip';
    chip.textContent = label;
    chip.addEventListener('click', () => {
      document.getElementById('prompt-input').value = prompt;
    });
    chipsContainer.appendChild(chip);
  });

  // --- GENERATION ---

  async function handleGenerate() {
    const prompt = document.getElementById('prompt-input').value.trim();
    if (!prompt) { showFieldError('prompt-error', 'Please describe the document you want to generate.'); return; }

    if (state.docGenerated) {
      if (!confirm('Replace the current document with a new one?')) return;
      closeEditPanel();
    }

    clearFieldError('prompt-error');
    showLoading('Generating document…');

    try {
      const raw      = await generateDocument(prompt, state.apiKey);
      state.sections = parseMarkdownToSections(raw);
      state.prompt   = prompt;

      hideLoading();

      // Switch from empty state to document view
      document.getElementById('document-empty-state').classList.add('hidden');
      document.getElementById('document-content').classList.remove('hidden');
      state.docGenerated = true;

      renderSidebar();
      renderDocumentView();
    } catch (err) {
      hideLoading();
      showFieldError('prompt-error', friendlyError(err));
    }
  }

  document.getElementById('btn-generate').addEventListener('click', handleGenerate);

  document.getElementById('prompt-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGenerate(); }
  });

  // --- NEW DOCUMENT ---

  document.getElementById('btn-new-doc').addEventListener('click', () => {
    if (state.sections.length > 0 && !confirm('Start a new document? Current document will be cleared.')) return;
    closeEditPanel();
    state.sections      = [];
    state.docGenerated  = false;
    state.prompt        = '';
    document.getElementById('document-empty-state').classList.remove('hidden');
    document.getElementById('document-content').classList.add('hidden');
    document.getElementById('document-content').innerHTML = '';
    document.getElementById('prompt-input').value = '';
    document.getElementById('doc-title').textContent = 'Untitled document';
    renderSidebar();
    clearFieldError('prompt-error');
  });

  // --- CONSTRAINTS POPOVER ---

  const pill      = document.getElementById('btn-constraints-toggle');
  const popover   = document.getElementById('constraints-popover');

  pill.addEventListener('click', e => {
    e.stopPropagation();
    const rect = pill.getBoundingClientRect();
    popover.style.right = `${window.innerWidth - rect.right}px`;
    popover.style.top   = `${rect.bottom + 6}px`;
    popover.style.position = 'fixed';
    popover.classList.toggle('hidden');
  });

  document.addEventListener('click', e => {
    if (!popover.contains(e.target) && e.target !== pill) {
      popover.classList.add('hidden');
    }
  });

  ['c-tone', 'c-audience', 'c-maxlength', 'c-custom'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      updateConstraintsBadge();
      if (state.activeSection) updateConstraintsSummary();
    });
    document.getElementById(id).addEventListener('change', () => {
      updateConstraintsBadge();
      if (state.activeSection) updateConstraintsSummary();
    });
  });

  // --- EDIT PANEL ---

  document.getElementById('btn-close-edit').addEventListener('click', closeEditPanel);

  document.getElementById('edit-instruction').addEventListener('input', e => {
    document.getElementById('btn-submit-edit').disabled = e.target.value.trim().length === 0;
  });

  document.getElementById('edit-instruction').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmitEdit(); }
    if (e.key === 'Escape') closeEditPanel();
  });

  async function handleSubmitEdit() {
    const instruction = document.getElementById('edit-instruction').value.trim();
    if (!instruction) return;

    const sectionId = state.activeSection;
    const section   = getSectionById(sectionId);
    if (!section) return;

    const oldContent = section.content;
    clearEditError();
    showLoading('Applying edit…');

    try {
      readConstraints();
      const newContent = await editSection(section, instruction, state.apiKey);

      pushHistory(sectionId, oldContent);
      section.content = newContent;
      section.status  = 'edited';

      hideLoading();
      renderSectionBlock(sectionId);
      applyDiffToBlock(sectionId, oldContent, newContent);
      refreshEditPanelContent(sectionId);
      dimAllExcept(sectionId);
      renderSidebar();

      const block = document.getElementById(`block-${sectionId}`);
      if (block) block.classList.add('active');
    } catch (err) {
      hideLoading();
      showEditError(friendlyError(err));
    }
  }

  document.getElementById('btn-submit-edit').addEventListener('click', handleSubmitEdit);

  document.getElementById('btn-undo-edit').addEventListener('click', () => {
    if (state.activeSection) undoSection(state.activeSection);
  });

  // --- CONSISTENCY CHECK ---

  document.getElementById('btn-consistency-check').addEventListener('click', runConsistencyCheck);

  // --- CONSISTENCY MODAL ---

  const modal = document.getElementById('modal-consistency');
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  modal.querySelector('.btn-close-modal').addEventListener('click', closeModal);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!modal.classList.contains('hidden')) { closeModal(); return; }
      if (state.activeSection) closeEditPanel();
    }
  });

  // --- EXPORT DROPDOWN ---

  const exportTrigger  = document.getElementById('btn-export-trigger');
  const exportDropdown = document.getElementById('export-dropdown');

  exportTrigger.addEventListener('click', e => {
    e.stopPropagation();
    exportDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', e => {
    if (!exportDropdown.contains(e.target) && e.target !== exportTrigger) {
      exportDropdown.classList.add('hidden');
    }
  });

  document.getElementById('btn-export-clipboard').addEventListener('click', () => { exportDropdown.classList.add('hidden'); exportToClipboard(); });
  document.getElementById('btn-export-md').addEventListener('click',        () => { exportDropdown.classList.add('hidden'); exportMarkdown(); });
  document.getElementById('btn-export-txt').addEventListener('click',       () => { exportDropdown.classList.add('hidden'); exportText(); });

});
