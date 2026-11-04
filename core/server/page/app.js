// The task window. It renders state from the server, saves ticks, and sends fixed events.
// All text is set as text nodes, so nothing from the state can run as markup.

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const app = $('app');
const sheet = $('sheet');
const content = $('content');
const live = $('live');
const toast = $('toast');
const announcer = $('announce');
const popout = /** @type {HTMLButtonElement} */ ($('popout'));
const away = $('away');

/** @type {any} */
let state = null;
/** @type {Window | null} */
let pipWindow = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;

const RUNGS = /** @type {Record<string, string>} */ ({ concept: 'Concept', approach: 'Approach', pseudocode: 'Pseudocode', snippet: 'Snippet' });
const CODE_RUNGS = new Set(['pseudocode', 'snippet']);

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

/** @param {number} n @param {string} one @param {string} [many] */
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
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

/** Tell screen readers about a change worth hearing, once. */
function announce(/** @type {string} */ text) {
  announcer.textContent = '';
  setTimeout(() => {
    announcer.textContent = text;
  }, 50);
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
  try {
    render(await post('/api/tick', { item, ticked }));
  } catch (err) {
    box.checked = !ticked;
    showToast(`Couldn't save that tick: ${/** @type {Error} */ (err).message}`, undefined, docOf({ target: box }));
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
      const what = { check: 'check your work', hint: 'give you the next hint', stuck: 'help you debug' }[type];
      showToast(`Sent. Your session will ${what} now.`, undefined, doc);
      return;
    }
    let copied = false;
    try {
      await (doc.defaultView ?? window).navigator.clipboard.writeText(r.command);
      copied = true;
    } catch {
      copied = false;
    }
    showToast(copied ? 'Copied. Paste it into your coding session:' : 'Type this in your coding session:', r.command, doc);
  } catch (err) {
    showToast(`That didn't work: ${/** @type {Error} */ (err).message}`, undefined, doc);
  }
}

/** @param {any} s */
function findingOf(s) {
  const c = s.card;
  if (c.owner === 'delegated') {
    return { tone: '', text: c.skipped ? 'You skipped this one, so Menitor is doing it' : 'Outside your focus areas, so Menitor is doing it' };
  }
  const lc = s.lastCheck;
  if (!lc) return { tone: '', text: 'Not checked yet' };
  if (lc.ok) return { tone: 'good', text: 'The last check passed' };
  return { tone: 'bad', text: `The last check found ${plural(lc.problems ?? 0, 'thing')} to fix` };
}

/** @param {any} s The buttons; fixed to the bottom on narrow screens, beside the title on wide ones. */
function actions(s) {
  return h(
    'div',
    { class: 'actions' },
    h('p', { class: 'how' }, s.listening ? 'Buttons go straight to your coding session.' : 'No session is listening, so buttons copy the command.'),
    h('button', { type: 'button', class: 'btn secondary', 'data-key': 'act:hint', onclick: (/** @type {Event} */ e) => onAction('hint', e) }, 'Hint'),
    h('button', { type: 'button', class: 'btn secondary', 'data-key': 'act:stuck', onclick: (/** @type {Event} */ e) => onAction('stuck', e) }, "I'm stuck"),
    h('button', { type: 'button', class: 'btn primary', 'data-key': 'act:check', onclick: (/** @type {Event} */ e) => onAction('check', e) }, 'Check my work'),
  );
}

/** @param {any} c The steps: the checklist in the one white inner card, then the done-when criteria. */
function stepsPanel(c) {
  const learner = c.owner === 'learner';
  const ticked = c.checklist.filter((/** @type {any} */ i) => i.ticked).length;
  const list = h('ul', { class: 'checklist inner' });
  for (const item of c.checklist) {
    const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: item.ticked, disabled: !learner, 'data-key': `tick:${item.id}` }));
    box.addEventListener('change', () => onTick(item.id, box));
    list.append(
      h(
        'li',
        { class: `item${item.ticked ? ' done' : ''}${learner ? '' : ' readonly'}` },
        h('label', null, box, h('span', { class: 'text' }, item.text, item.source === 'fix' ? h('span', { class: 'pill negative' }, 'Fix') : null)),
      ),
    );
  }
  return h(
    'section',
    { class: 'panel steps', 'aria-labelledby': 'steps-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'steps-title' }, 'Steps'), learner ? h('span', { class: 'count num' }, `${ticked} of ${c.checklist.length} done`) : null),
    list,
    h('div', { class: 'done-when' }, h('h3', null, 'Done when'), h('ul', null, ...c.doneWhen.map((/** @type {string} */ d) => h('li', null, d)))),
    c.note ? h('p', { class: 'note' }, c.note) : null,
  );
}

/** @param {any} c The hint ladder: four rungs, opened one at a time (H-2). */
function hintsPanel(c) {
  const { stored, revealed, rungs } = c.hints;
  /** @type {(Node | null)[]} */
  const side = [h('header', { class: 'panel-head' }, h('h2', { id: 'hints-title' }, 'Hints'), stored ? h('span', { class: 'count num' }, `${revealed} of ${rungs.length} open`) : null)];
  const body = [];
  if (!stored) {
    body.push(h('p', { class: 'empty' }, "This milestone's hints are written when you first ask for one."));
  } else {
    const ladder = h('ol', { class: 'ladder', 'aria-label': 'Hint ladder' });
    for (const r of rungs) ladder.append(h('li', { class: `rung${r.open ? ' open' : ''}` }, RUNGS[r.rung] ?? r.rung, h('span', { class: 'sr-only' }, r.open ? ' (open)' : ' (locked)')));
    side.push(ladder);
    for (const r of rungs) {
      if (!r.open || !r.text) continue;
      const text = CODE_RUNGS.has(r.rung) ? h('pre', null, h('code', null, r.text)) : h('p', null, r.text);
      body.push(h('div', { class: 'hint' }, h('h3', null, RUNGS[r.rung] ?? r.rung), text));
    }
    if (revealed === 0) body.push(h('p', { class: 'empty hint' }, 'None open yet. The first one is the idea, never the code.'));
    if (!body.length) body.push(h('p', { class: 'empty' }, 'None open yet.'));
    if (revealed === rungs.length) body.push(h('p', { class: 'note' }, "All four are open. If you're still stuck, debug it together."));
  }
  return h('section', { class: 'panel hints', 'aria-labelledby': 'hints-title' }, h('div', { class: 'hints-side' }, ...side), h('div', { class: 'hints-body' }, ...body));
}

/** @param {any} c What to read first, the doc section the task builds, and its branch. */
function learnPanel(c) {
  const kv = h('dl', { class: 'kv' }, h('dt', null, 'Docs'), h('dd', null, h('code', null, c.docs)));
  if (c.branch) kv.append(h('dt', null, 'Branch'), h('dd', null, h('code', null, c.branch)));
  let learn = null;
  if (c.learn?.url) {
    learn = h(
      'a',
      { class: 'learn-link', href: c.learn.url, target: '_blank', rel: 'noopener noreferrer', 'data-key': 'learn' },
      c.learn.label,
      h('span', { 'aria-hidden': 'true' }, ' ↗'),
      h('span', { class: 'sr-only' }, ' (opens in a new tab)'),
    );
  } else if (c.learn) {
    learn = h('p', { class: 'learn-link' }, c.learn.label);
  }
  return h('section', { class: 'panel learn', 'aria-labelledby': 'learn-title' }, h('header', { class: 'panel-head' }, h('h2', { id: 'learn-title' }, 'Before you code')), learn, kv);
}

const KIND_WORDS = /** @type {Record<string, string>} */ ({
  you: 'done, written by you',
  menitor: 'done by Menitor',
  skipped: 'done by Menitor after you skipped it',
  now: 'the current task',
  todo: 'to do',
});

/** @param {any} s W-8, the signature element: every task in the plan as one cell, marked by who did it. */
function planPanel(s) {
  const counts = /** @type {Record<string, number>} */ ({ you: 0, menitor: 0, skipped: 0, now: 0, todo: 0 });
  const rows = h('ol', { class: 'ledger' });
  for (const m of s.milestones) {
    const cells = h('ol', { class: 'cells' });
    for (const t of m.tasks ?? []) {
      const kind = t.current ? 'now' : !t.done ? 'todo' : t.skipped ? 'skipped' : t.by === 'learner' ? 'you' : 'menitor';
      counts[kind] += 1;
      cells.append(h('li', { class: `cell ${kind}`, title: `Task ${t.number}: ${t.goal}` }, h('span', { class: 'sr-only' }, `Task ${t.number}, ${t.goal}: ${KIND_WORDS[kind]}`)));
    }
    rows.append(
      h(
        'li',
        { class: `ms${m.current ? ' current' : ''}` },
        h('span', { class: 'ms-name', title: m.title }, m.title),
        h('span', { class: 'ms-count', 'aria-label': `${m.done} of ${m.total} done` }, `${m.done}/${m.total}`),
        cells,
      ),
    );
  }
  const legend = h('ul', { class: 'legend', 'aria-label': 'Key' });
  /** @param {string} kind @param {string} label @param {boolean} [count] */
  const key = (kind, label, count = true) => {
    if (counts[kind]) legend.append(h('li', null, h('span', { class: `swatch ${kind}` }), label, count ? ' ' : null, count ? h('b', null, String(counts[kind])) : null));
  };
  key('you', 'Written by you');
  key('menitor', 'Menitor');
  key('skipped', 'Skipped');
  key('now', 'Now', false);
  key('todo', 'To do');
  return h(
    'section',
    { class: 'panel plan', 'aria-labelledby': 'plan-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'plan-title' }, 'Plan'), h('span', { class: 'count num' }, `${s.done} of ${plural(s.total, 'task')} done`)),
    rows,
    legend,
  );
}

/** @param {any} s */
function taskView(s) {
  const c = s.card;
  const learner = c.owner === 'learner';
  const f = findingOf(s);
  const head = h(
    'header',
    { class: 'head' },
    h(
      'div',
      { class: 'head-text' },
      h('h1', { id: 'title' }, c.goal),
      h('p', { class: 'status' }, h('span', { class: 'num' }, `Task ${c.number} of ${c.total} · ${c.milestone.title}`), h('span', { class: `finding ${f.tone}` }, f.text)),
      h('p', { class: 'why' }, c.why),
    ),
    learner ? actions(s) : null,
  );
  // DOM order is the phone's reading order: steps, hints, then the rail. Desktop places the rail beside the steps.
  const board = h('div', { class: 'board' }, stepsPanel(c), learner ? hintsPanel(c) : null, h('div', { class: 'col rail' }, learnPanel(c), planPanel(s)));
  return { nodes: [head, board], bar: learner };
}

/** @param {any} s */
function messageView(s) {
  const cmd = (/** @type {string} */ k, /** @type {string} */ fallback) => s.commands?.[k] ?? fallback;
  /** @type {Record<string, [string, string]>} */
  const messages = {
    'no-plan': ['No plan yet', `Start one in your coding session with ${cmd('start', 'the start command')}.`],
    draft: ['Setup is running', 'Your first task shows up here once you approve the plan.'],
    done: ['Every task is done', 'Nice work. Polish the README, then share your deployed link.'],
  };
  const [title, text] = messages[s.phase] ?? ['Menitor', ''];
  const nodes = [h('div', { class: 'message' }, h('h1', null, title), h('p', null, text))];
  if (s.phase === 'done' && s.total) nodes.push(h('div', { class: 'board single' }, planPanel(s)));
  return { nodes, bar: false };
}

/** @param {string} title @param {string} text */
function problemView(title, text) {
  return { nodes: [h('div', { class: 'message' }, h('h1', null, title), h('p', null, text))], bar: false };
}

/**
 * Say what changed since the last render, for screen readers.
 * @param {any} prev
 * @param {any} s
 */
function announceChanges(prev, s) {
  if (!prev?.card || !s.card) return;
  if (prev.card.task !== s.card.task) {
    announce(`Now on task ${s.card.number} of ${s.card.total}: ${s.card.goal}`);
    return;
  }
  if (s.lastCheck && s.lastCheck.at !== prev.lastCheck?.at) announce(findingOf(s).text);
  else if (s.card.hints.revealed > prev.card.hints.revealed) announce(`${RUNGS[s.card.hints.rungs[s.card.hints.revealed - 1]?.rung] ?? 'A'} hint is open`);
  else if (s.card.checklist.length > prev.card.checklist.length) announce(`${plural(s.card.checklist.length - prev.card.checklist.length, 'fix', 'fixes')} added to the steps`);
}

/** @param {any} s */
function render(s) {
  const prev = state;
  state = s;
  // Keep the keyboard where it was: a tick re-renders the card.
  const doc = app.ownerDocument;
  const focusKey = /** @type {HTMLElement | null} */ (doc.activeElement)?.dataset?.key;

  let view;
  if (!s.ok) view = problemView("Menitor's state has a problem", `${s.error} Ask your coding session to validate Menitor's state and fix it.`);
  else if (s.phase === 'task' && s.card) view = taskView(s);
  else view = messageView(s);

  const notice = s.ok && s.mentorMode === 'off' ? h('p', { class: 'notice', role: 'status' }, 'Mentor mode is off, so the agent may write code anywhere.') : null;
  content.replaceChildren(...(notice ? [notice] : []), ...view.nodes);
  sheet.classList.toggle('has-bar', view.bar);

  $('project').textContent = s.project ?? 'Your project';
  doc.title = s.card ? `${s.card.number}/${s.card.total} · ${s.card.goal}` : 'Menitor';
  if (focusKey) /** @type {HTMLElement | null} */ (content.querySelector(`[data-key="${CSS.escape(focusKey)}"]`))?.focus({ preventScroll: true });
  if (s.ok) announceChanges(prev, s);
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
        const go = state?.commands?.go ?? 'the go command';
        const view = problemView('This window is out of date', `Ask for the current task again in your session (${go}) to get a fresh link.`);
        content.replaceChildren(...view.nodes);
        sheet.classList.remove('has-bar');
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
      window.open('/', 'menitor-card', 'popup,width=400,height=760');
    });
    return;
  }
  popout.addEventListener('click', async () => {
    if (pipWindow) {
      pipWindow.close();
      return;
    }
    const pip = await pipApi.requestWindow({ width: 400, height: 720 });
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
