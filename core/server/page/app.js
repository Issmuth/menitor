// The task window. It renders state from the server, saves ticks, and sends fixed events.
// All text is set with textContent, so nothing from the state can run as markup.

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const app = $('app');
const card = $('card');
const progress = $('progress');
const banner = $('banner');
const live = $('live');
const toast = $('toast');
const popout = /** @type {HTMLButtonElement} */ ($('popout'));
const away = $('away');

/** @type {any} */
let state = null;
/** @type {Window | null} */
let pipWindow = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;

/**
 * Make an element. Strings become text nodes; never HTML.
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...(Node | string | null | false | undefined)} children
 */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') /** @type {any} */ (el)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c !== 'string' && !(c instanceof Node)) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** The document a click happened in: the main page or the pop-out. */
function docOf(/** @type {{ target: EventTarget | null } | undefined} */ e) {
  const t = /** @type {Node | null} */ (e?.target ?? null);
  return t?.ownerDocument ?? document;
}

/**
 * @param {string} text
 * @param {string} [code]
 * @param {Document} [doc]
 */
function showToast(text, code, doc = document) {
  const el = doc === document ? toast : /** @type {HTMLElement} */ (doc.getElementById('toast'));
  if (!el) return;
  el.replaceChildren(text, code ? ' ' : '', code ? h('code', null, code) : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 5000);
}

/**
 * @param {string} path
 * @param {unknown} body
 */
async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
}

/**
 * W-3: save a tick; put the box back if the server refuses.
 * @param {string} item
 * @param {HTMLInputElement} box
 */
async function onTick(item, box) {
  const ticked = box.checked;
  box.disabled = true;
  try {
    render(await post('/api/tick', { item, ticked }));
  } catch (err) {
    box.checked = !ticked;
    showToast(`Couldn't save that tick: ${/** @type {Error} */ (err).message}`, undefined, docOf({ target: box }));
  } finally {
    box.disabled = false;
  }
}

/**
 * W-6: ask the session to act. If nothing is listening, copy the command to type instead.
 * @param {'check' | 'hint' | 'stuck'} type
 * @param {Event} e
 */
async function onAction(type, e) {
  const doc = docOf(e);
  try {
    const r = await post('/api/event', { type });
    if (r.delivered) {
      showToast(`Sent "${type}" to your session.`, undefined, doc);
      return;
    }
    const command = r.command;
    let copied = false;
    try {
      await (doc.defaultView ?? window).navigator.clipboard.writeText(command);
      copied = true;
    } catch {
      copied = false;
    }
    showToast(copied ? 'Copied. Paste it into your coding session:' : 'Type this in your coding session:', command, doc);
  } catch (err) {
    showToast(`That didn't work: ${/** @type {Error} */ (err).message}`, undefined, doc);
  }
}

const RUNG_NAMES = /** @type {Record<string, string>} */ ({ concept: 'concept', approach: 'approach', pseudocode: 'pseudocode', snippet: 'snippet' });

/** @param {any} c */
function renderCard(c) {
  const learnerTask = c.owner === 'learner';
  const fields = h('dl', { class: 'fields' }, h('dt', null, 'Why'), h('dd', null, c.why));
  if (c.learn) {
    const learn = c.learn.url ? h('a', { href: c.learn.url, target: '_blank', rel: 'noopener noreferrer' }, c.learn.label) : c.learn.label;
    fields.append(h('dt', null, 'Learn'), h('dd', null, learn));
  }
  fields.append(h('dt', null, 'Docs'), h('dd', null, h('code', null, c.docs)));
  if (c.branch) fields.append(h('dt', null, 'Branch'), h('dd', null, h('code', null, c.branch)));

  const ticked = c.checklist.filter((/** @type {any} */ i) => i.ticked).length;
  const list = h('fieldset', { class: 'checklist' }, h('legend', null, `Checklist · ${ticked} of ${c.checklist.length}`));
  for (const item of c.checklist) {
    const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: item.ticked, disabled: !learnerTask || c.status === 'done' }));
    box.addEventListener('change', () => onTick(item.id, box));
    list.append(
      h(
        'label',
        { class: `item${item.ticked ? ' done' : ''}` },
        box,
        h('span', null, item.source === 'fix' ? h('span', { class: 'fix' }, 'Fix') : null, item.source === 'fix' ? ' ' : null, item.text),
      ),
    );
  }

  const done = h('dl', { class: 'fields' });
  c.doneWhen.forEach((/** @type {string} */ d, /** @type {number} */ i) => done.append(h('dt', null, i === 0 ? 'Done when' : ''), h('dd', null, d)));

  const rungs = h('ul', { class: 'hints', 'aria-label': 'Hints' });
  const open = [];
  for (const r of c.hints.rungs) {
    rungs.append(h('li', { class: r.open ? 'open' : '' }, `${RUNG_NAMES[r.rung] ?? r.rung}${r.open ? '' : ' · locked'}`));
    if (r.open && r.text) open.push(h('p', { class: 'hint-text' }, h('strong', null, r.rung), r.text));
  }

  const actions = learnerTask
    ? h(
        'div',
        { class: 'actions' },
        h('button', { type: 'button', onclick: (/** @type {Event} */ e) => onAction('check', e) }, 'Check my work'),
        h('button', { type: 'button', class: 'secondary', onclick: (/** @type {Event} */ e) => onAction('hint', e) }, 'Hint'),
        h('button', { type: 'button', class: 'secondary', onclick: (/** @type {Event} */ e) => onAction('stuck', e) }, "I'm stuck"),
      )
    : h('p', { class: 'note' }, c.skipped ? 'You skipped this one, so Menitor is doing it.' : 'This task is outside your focus areas, so Menitor is doing it.');

  /** @type {HTMLElement | null} */
  let last = null;
  if (state?.lastCheck) {
    const lc = state.lastCheck;
    last = h('p', { class: `lastcheck ${lc.ok ? 'ok' : 'bad'}` }, lc.ok ? 'Last check: the automatic checks passed.' : `Last check: ${lc.problems ?? 'some'} thing${lc.problems === 1 ? '' : 's'} to fix.`);
  }

  /** @type {(Node | null)[]} */
  const parts = [
    h('p', { class: 'eyebrow' }, `Task ${c.number}/${c.total} · Milestone ${c.milestone.number}: ${c.milestone.title}`),
    learnerTask ? null : h('span', { class: 'badge' }, c.skipped ? 'Skipped · Menitor' : 'Delegated · Menitor'),
    h('h1', { class: 'goal', id: 'card-title' }, c.goal),
    fields,
    list,
    done,
    rungs,
    ...open,
    actions,
    last,
    c.note ? h('p', { class: 'note' }, c.note) : null,
  ];
  card.replaceChildren(.../** @type {Node[]} */ (parts.filter(Boolean)));
}

/** @param {any} s */
function renderMessage(s) {
  const cmd = (/** @type {string} */ k, /** @type {string} */ fallback) => s.commands?.[k] ?? fallback;
  /** @type {Record<string, [string, string]>} */
  const messages = {
    'no-plan': ['No plan yet', `Start one in your coding session with ${cmd('start', 'the start command')}.`],
    draft: ['Setup is running', 'The first task shows up here once you approve the plan.'],
    done: ['Every task is done', 'Nice work. Polish the README and share your deployed link.'],
  };
  const [title, text] = messages[s.phase] ?? ['Menitor', ''];
  card.replaceChildren(h('h1', { class: 'goal' }, title), h('p', { class: 'muted' }, text));
}

/**
 * A progress bar. The width is set through the style API: the page's CSP forbids style attributes.
 * @param {string} label
 * @param {number} value
 * @param {number} max
 */
function meter(label, value, max) {
  const fill = h('span');
  fill.style.width = `${max ? Math.round((value / max) * 100) : 0}%`;
  return h('span', { class: 'meter', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value) }, fill);
}

/** @param {any} s W-8: milestone progress and who wrote what. */
function renderProgress(s) {
  if (!s.total) {
    progress.hidden = true;
    return;
  }
  const list = h('ul', { class: 'milestones' });
  for (const m of s.milestones) {
    list.append(
      h(
        'li',
        { class: m.current ? 'current' : '' },
        h('span', { class: 'name' }, `M${m.number} ${m.title}`),
        h('span', { class: 'muted' }, `${m.done}/${m.total}`),
        meter(`Milestone ${m.number}`, m.done, m.total),
      ),
    );
  }
  const w = s.written;
  const skipped = w.skipped ? ` (${w.skipped} skipped)` : '';
  progress.replaceChildren(
    h('h2', null, `${s.done} of ${s.total} tasks done`),
    meter('All tasks', s.done, s.total),
    list,
    h('p', { class: 'counts' }, `Written by you: ${w.learner} · Delegated: ${w.delegated}${skipped}`),
  );
  progress.hidden = false;
}

/** @param {any} s */
function render(s) {
  state = s;
  card.setAttribute('aria-busy', 'false');
  if (!s.ok) {
    card.replaceChildren(h('h1', { class: 'goal' }, "Menitor's state has a problem"), h('p', { class: 'muted' }, s.error));
    progress.hidden = true;
    return;
  }
  $('project').textContent = s.project ?? 'Menitor';
  document.title = s.card ? `${s.card.number}/${s.card.total} · ${s.card.goal}` : 'Menitor';
  banner.hidden = s.mentorMode !== 'off';
  banner.textContent = s.mentorMode === 'off' ? 'Mentor mode is off: the agent may write code anywhere.' : '';
  if (s.phase === 'task' && s.card) renderCard(s.card);
  else renderMessage(s);
  renderProgress(s);
}

/** @param {'connecting' | 'live' | 'lost'} kind */
function setLive(kind) {
  live.dataset.state = kind;
  live.textContent = kind === 'live' ? 'Live' : kind === 'lost' ? 'Reconnecting' : 'Connecting';
}

function connect() {
  const events = new EventSource('/api/events');
  events.addEventListener('state', (e) => {
    setLive('live');
    render(JSON.parse(/** @type {MessageEvent} */ (e).data));
  });
  events.addEventListener('error', async () => {
    setLive('lost');
    // A restarted server has a new token: this page can't reconnect on its own.
    try {
      const res = await fetch('/api/ping', { credentials: 'same-origin' });
      if (res.status === 401) {
        events.close();
        card.replaceChildren(h('h1', { class: 'goal' }, 'This window is out of date'), h('p', { class: 'muted' }, `Ask for the current task again in your session (${state?.commands?.go ?? 'the go command'}) to get a fresh link.`));
      }
    } catch {
      // The server is down; EventSource keeps retrying.
    }
  });
}

/** W-4: an always-on-top mini window with Document Picture-in-Picture, or a small window. */
function setupPopout() {
  const pipApi = /** @type {any} */ (window).documentPictureInPicture;
  popout.hidden = false;
  if (!pipApi) {
    popout.textContent = 'Open small';
    popout.addEventListener('click', () => {
      window.open('/', 'menitor-card', 'popup,width=400,height=720');
    });
    return;
  }
  popout.addEventListener('click', async () => {
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    const pip = await pipApi.requestWindow({ width: 380, height: 640 });
    pipWindow = pip;
    const link = pip.document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('/style.css', location.href).href;
    pip.document.head.append(link);
    pip.document.title = 'Menitor';
    pip.document.body.classList.add('pip');
    const pipToast = toast.cloneNode();
    pip.document.body.append(app, pipToast);
    away.hidden = false;
    popout.textContent = 'Pop in';
    pip.addEventListener('pagehide', () => {
      document.body.prepend(app);
      away.hidden = true;
      popout.textContent = 'Pop out';
      pipWindow = null;
    });
  });
  $('bring-back').addEventListener('click', () => pipWindow?.close());
}

setupPopout();
connect();
