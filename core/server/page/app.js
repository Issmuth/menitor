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
// Held here: the header moves with the app into the pop-out, where getElementById can't see it.
const projectName = $('project');
const tabsNav = $('tabs');

/** @type {any} */
let state = null;
/** @type {Window | null} */
let pipWindow = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastTimer;

/** Type-along: which steps are open. The step after the last tick opens by itself; others open by hand. */
let accordion = { task: /** @type {string | null} */ (null), current: /** @type {string | null} */ (null), open: new Set(/** @type {string[]} */ ([])) };
/** Set when a tick moved the open step, so the next render brings it into view. */
let revealNext = false;
let lastNudge = 0;
/** Answers being typed, by question ID, so a live update never wipes them. */
const drafts = new Map();
/** Answers sent but being changed again. */
const editing = new Set();

const RUNGS = /** @type {Record<string, string>} */ ({ concept: 'Concept', approach: 'Approach', pseudocode: 'Pseudocode', snippet: 'Snippet' });
const CODE_RUNGS = new Set(['pseudocode', 'snippet']);

/** The tab on screen: the main screen (the task, setup or the finish) or the to-do list. */
let tab = /** @type {'main' | 'todos'} */ (location.hash === '#todos' ? 'todos' : 'main');
/** Where each tab was scrolled to, so going back keeps the place. */
const scrollByTab = { main: 0, todos: 0 };

/** Which folded groups of the plan are open: the milestones done, and those still to come. */
function readPlanOpen() {
  try {
    const v = JSON.parse(localStorage.getItem('menitor.plan-open') ?? '{}');
    return { done: v.done === true, later: v.later === true };
  } catch {
    return { done: false, later: false };
  }
}
let planOpen = readPlanOpen();

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

/** @type {ReturnType<typeof setTimeout> | undefined} */
let toastLeave;

/**
 * @param {string} text
 * @param {string} [code]
 * @param {Document} [doc]
 */
function showToast(text, code, doc = document) {
  const el = doc === document ? toast : /** @type {HTMLElement} */ (doc.getElementById('toast'));
  if (!el) return;
  el.replaceChildren(text, code ? ' ' : '', code ? h('code', null, code) : '');
  el.classList.remove('leaving');
  el.hidden = false;
  clearTimeout(toastTimer);
  clearTimeout(toastLeave);
  toastTimer = setTimeout(() => {
    // It fades out, a little faster than it came in, then leaves the page.
    el.classList.add('leaving');
    toastLeave = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('leaving');
    }, 180);
  }, 5000);
}

/*
 * Motion is feedback: what just changed says so once, then holds still. The page redraws from
 * state on every update, so a change is marked by its element's data-m key, and the element drawn
 * next carries the motion on from where it was instead of starting it over.
 */

/** @type {Map<string, { cls: string, at: number, ms: number, delay: number }>} */
const motionMarks = new Map();

/**
 * @param {string} key the element's data-m
 * @param {string} cls the motion class
 * @param {number} ms how long it runs
 * @param {number} [delay] a stagger before it starts
 */
function mark(key, cls, ms, delay = 0) {
  motionMarks.set(key, { cls, at: performance.now(), ms: ms + delay, delay });
}

/** @param {Element} root Put the motions still running on the elements just drawn. */
function applyMotion(root) {
  if (!motionMarks.size) return;
  const now = performance.now();
  for (const [key, m] of motionMarks) if (now - m.at > m.ms) motionMarks.delete(key);
  for (const el of root.querySelectorAll('[data-m]')) {
    const m = motionMarks.get(/** @type {HTMLElement} */ (el).dataset.m ?? '');
    if (!m) continue;
    el.classList.add(m.cls);
    // A negative delay picks the motion up part way, so a redraw mid-motion doesn't restart it.
    /** @type {HTMLElement} */ (el).style.setProperty('--m-delay', `${Math.round(m.delay - (now - m.at))}ms`);
  }
}

/**
 * What changed between two states, marked for motion: a tick, a fix or a hint arriving, a reply,
 * a pass filling its cell, the next task's cell, a to-do added or done.
 * @param {any} prev
 * @param {any} s
 */
function markChanges(prev, s) {
  if (!prev?.ok || !s?.ok || prev === s) return;
  const a = prev.card;
  const b = s.card;
  if (a && b && a.task === b.task) {
    const was = new Map(a.checklist.map((/** @type {any} */ i) => [i.id, i]));
    for (const item of b.checklist) {
      const old = /** @type {any} */ (was.get(item.id));
      if (!old) mark(`item:${item.id}`, 'm-arrive', 360);
      else if (item.ticked && !old.ticked) mark(`tick:${item.id}`, 'm-tick', 340);
    }
    for (let i = a.hints.revealed; i < b.hints.revealed; i++) {
      mark(`rung:${i}`, 'm-rung', 520);
      const rung = b.hints.rungs[i]?.rung;
      if (rung) mark(`hint:${rung}`, 'm-arrive', 400, 120);
    }
    if (findingOf(prev).text !== findingOf(s).text) mark('finding', 'm-fade', 300);
  }
  if (pressLine(prev).text !== pressLine(s).text) mark('how-line', 'm-fade', 300);
  const asked = new Map((prev.questions ?? []).map((/** @type {any} */ q) => [q.id, q]));
  for (const q of s.questions ?? []) {
    const old = /** @type {any} */ (asked.get(q.id));
    if (!old) mark(`q:${q.id}`, 'm-arrive', 400);
    else if (q.feedback && !old.feedback) mark(`fb:${q.id}`, 'm-arrive', 400);
  }
  if (s.waiting && s.waiting.text !== prev.waiting?.text) mark('waiting', 'm-arrive', 400);
  const saved = new Set((prev.setup?.steps ?? []).filter((/** @type {any} */ x) => x.done).map((/** @type {any} */ x) => x.key));
  for (const x of s.setup?.steps ?? []) {
    if (!x.done || saved.has(x.key) || !prev.setup) continue;
    mark(`setup:${x.key}`, 'm-fade', 360);
    mark(`told:${x.key}`, 'm-arrive', 360);
  }
  const tasks = new Map((prev.milestones ?? []).flatMap((/** @type {any} */ m) => m.tasks ?? []).map((/** @type {any} */ t) => [t.id, t]));
  for (const t of (s.milestones ?? []).flatMap((/** @type {any} */ m) => m.tasks ?? [])) {
    const old = /** @type {any} */ (tasks.get(t.id));
    if (!old) mark(`cell:${t.id}`, 'm-arrive', 400);
    else if (t.done && !old.done) mark(`cell:${t.id}`, 'm-fill', 560);
    else if (t.current && !old.current) mark(`cell:${t.id}`, 'm-now', 760, 240);
  }
  const todos = new Map((prev.todos ?? []).map((/** @type {any} */ t) => [t.id, t]));
  for (const t of s.todos ?? []) {
    const old = /** @type {any} */ (todos.get(t.id));
    if (!old) mark(`todo:${t.id}`, 'm-arrive', 360);
    else if (t.done && !old.done) mark(`todo:${t.id}`, 'm-done', 360);
    else if (t.planned && !old.planned) mark(`planned:${t.id}`, 'm-arrive', 360);
  }
}

/** @param {'done' | 'later'} which A group of milestones unfolding: each row drops in, a beat apart. */
function markPlanGroup(which) {
  const ms = /** @type {any[]} */ (state?.milestones ?? []);
  const current = ms.findIndex((m) => m.current);
  if (current < 0) return;
  const group = which === 'done' ? ms.slice(0, current) : ms.slice(current + 1);
  group.forEach((m, i) => mark(`ms:${m.id}`, 'm-drop', 280, Math.min(i, 4) * 40));
}

/** Transitions running, so the last one to finish takes the names away. */
let transitions = 0;

/**
 * Change views with a short crossfade: the old view fades, the new one rises a few pixels, and the
 * open tab's pill glides to its new tab. Reduced motion, and browsers without view transitions,
 * change at once.
 * @param {() => void} update
 */
function withTransition(update) {
  const doc = /** @type {any} */ (content.ownerDocument);
  const still = doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (typeof doc.startViewTransition !== 'function' || still || doc.visibilityState === 'hidden') {
    update();
    return;
  }
  transitions += 1;
  doc.documentElement.classList.add('vt');
  const t = doc.startViewTransition(update);
  t.finished.finally(() => {
    transitions -= 1;
    if (!transitions) doc.documentElement.classList.remove('vt');
  });
}

/**
 * Which screen a state puts on screen; a change of screen fades through. A pass that lands while
 * the to-dos or a finished task are open changes nothing on screen, so it doesn't.
 * @param {any} s
 */
function viewKey(s) {
  if (finished) return `finished|${finished.id}|${s?.ok}`;
  if (tab === 'todos') return `todos|${s?.ok}`;
  return ['main', s?.ok, s?.phase, s?.result?.task ?? '', s?.card?.task ?? ''].join('|');
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
 * @param {'check' | 'hint' | 'stuck' | 'go'} type
 * @param {Event} e
 */
async function onAction(type, e) {
  const doc = docOf(e);
  if (busyPress(state)) return;
  try {
    const r = await post('/api/event', { type });
    if (r.busy) {
      showToast('Menitor is still working on your last press.', undefined, doc);
      return;
    }
    if (r.delivered) {
      // Show it as sent at once; the server's next state takes over within a moment.
      localPress = { type, at: new Date().toISOString(), claimedAt: null, state: 'sent', doneAt: null };
      render(state);
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
    if (s.goAskedAt) return { tone: 'ask', text: 'Menitor is working on it' };
    return { tone: '', text: c.skipped ? 'You skipped this one, so Menitor does it' : 'Outside your focus areas, so Menitor does it' };
  }
  const open = openQuestion(s);
  if (open) return { tone: 'ask', text: open.answer ? 'Menitor is reading your answer' : 'Answer the question below to finish' };
  if (s.skipRequested) return { tone: '', text: 'You asked to skip this task' };
  const lc = s.lastCheck;
  if (!lc) return { tone: '', text: 'Not checked yet' };
  if (lc.ok) return { tone: 'good', text: 'The last check passed' };
  return { tone: 'bad', text: `The last check found ${plural(lc.problems ?? 0, 'thing')} to fix` };
}

/** What a press is doing, in the button and in words. */
const PRESS_WORDS = /** @type {Record<string, { busy: string, doing: string }>} */ ({
  check: { busy: 'Checking…', doing: 'Menitor is checking your work.' },
  hint: { busy: 'Writing…', doing: 'Menitor is writing your next hint.' },
  stuck: { busy: 'Looking…', doing: 'Menitor is looking at what went wrong.' },
  go: { busy: 'Starting…', doing: 'Menitor is working on this task.' },
  add: { busy: 'Adding…', doing: 'Menitor is adding your to-do to the plan.' },
});
/** A press shows as done for this long, saying what comes next. */
const DONE_SHOWN_MS = 2 * 60 * 1000;
/** A press this page just sent, until the server's state shows it. */
/** @type {any} */
let localPress = null;

/**
 * The press to show: the server's, or the one this page just sent if the server hasn't seen it yet.
 * @param {any} s
 */
function pressOf(s) {
  if (s?.press && (!localPress || s.press.at >= localPress.at)) return s.press;
  return localPress && Date.now() - Date.parse(localPress.at) < 10000 ? localPress : (s?.press ?? null);
}

/** @param {any} s A press that is still on its way or being worked on. */
function busyPress(s) {
  const p = pressOf(s);
  return p && p.state !== 'done' ? p : null;
}

/**
 * A button that sends a press. While a press is pending, the pressed one shows what it's doing and
 * the others wait; nothing more is sent.
 * @param {any} s
 * @param {'check' | 'hint' | 'stuck' | 'go'} type
 * @param {string} label
 * @param {string} kind
 */
function pressButton(s, type, label, kind) {
  const busy = busyPress(s);
  const mine = busy?.type === type;
  return h(
    'button',
    {
      type: 'button',
      class: `btn ${kind}${mine ? ' busy' : ''}`,
      'data-key': `act:${type}`,
      disabled: Boolean(busy && !mine),
      'aria-disabled': mine ? 'true' : undefined,
      'aria-busy': mine ? 'true' : undefined,
      onclick: (/** @type {Event} */ e) => onAction(type, e),
    },
    mine ? (busy.state === 'sent' ? 'Sent' : PRESS_WORDS[type].busy) : label,
  );
}

/**
 * The line above the buttons: what a press is doing, what comes next once it's done, or how the
 * buttons reach the session.
 * @param {any} s
 */
function pressLine(s) {
  const p = pressOf(s);
  if (p?.state === 'sent') return { busy: true, text: 'Sent. Waiting for your session to pick it up.' };
  if (p?.state === 'working') return { busy: true, text: PRESS_WORDS[p.type].doing };
  if (p?.state === 'done' && p.doneAt && Date.now() - Date.parse(p.doneAt) < DONE_SHOWN_MS && s.card) {
    const checked = s.lastCheck?.at && p.claimedAt && s.lastCheck.at >= p.claimedAt;
    const next = {
      check: checked ? `${findingOf(s).text}.` : 'See your session for what it found.',
      hint: 'Your hint is open below.',
      stuck: 'The next step is in your session.',
      go: '',
      add: 'If it asked you something, answer in your session.',
    }[/** @type {string} */ (p.type)];
    return { busy: false, text: `Menitor is done. ${next}`.trim() };
  }
  return { busy: false, text: s.listening ? 'Menitor is listening: buttons go straight to your session.' : "Menitor isn't listening right now, so buttons copy the command." };
}

/** @param {any} s The buttons; fixed to the bottom on narrow screens, beside the title on wide ones. */
function actions(s) {
  const line = pressLine(s);
  return h(
    'div',
    { class: `actions${line.busy ? ' pending' : ''}` },
    h('p', { class: `how${line.busy ? ' working' : ''}`, 'data-m': 'how-line' }, line.text),
    s.typeAlong ? null : pressButton(s, 'hint', 'Hint', 'secondary'),
    pressButton(s, 'stuck', "I'm stuck", 'secondary'),
    pressButton(s, 'check', 'Check my work', openQuestion(s) ? 'secondary' : 'primary'),
  );
}

/** @param {any} s */
function openQuestion(s) {
  return (s.questions ?? []).find((/** @type {any} */ q) => q.outcome === null) ?? null;
}

/** @param {string} iso */
function clock(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A banner for what stands between the learner and the next task, besides the steps.
 * @param {'you' | 'menitor'} whose
 * @param {string} title
 * @param {string} text
 * @param {...(Node | null)} extra
 */
function callout(whose, title, text, ...extra) {
  return h('section', { class: `callout ${whose}`, 'aria-labelledby': `callout-${whose}` }, h('div', { class: 'callout-text' }, h('h2', { id: `callout-${whose}` }, title), h('p', null, text)), h('div', { class: 'callout-actions' }, ...extra));
}

/**
 * @param {string} text
 * @param {Event} e
 */
async function copyCommand(text, e) {
  const doc = docOf(e);
  try {
    await (doc.defaultView ?? window).navigator.clipboard.writeText(text);
    showToast('Copied. Paste it into your coding session:', text, doc);
  } catch {
    showToast('Type this in your coding session:', text, doc);
  }
}

/**
 * C-5: send the answer typed here. It's saved as data; the session only hears that it arrived.
 * @param {any} q
 * @param {HTMLTextAreaElement} box
 * @param {Event} e
 */
async function sendAnswer(q, box, e) {
  const doc = docOf(e);
  const text = box.value.trim();
  if (!text) {
    showToast('Write your answer first, in your own words.', undefined, doc);
    box.focus();
    return;
  }
  try {
    const r = await post('/api/answer', { question: q.id, text });
    drafts.delete(q.id);
    editing.delete(q.id);
    render(r.state);
    if (r.delivered) showToast('Sent. Menitor will read it now.', undefined, doc);
    else showToast('Saved. To have Menitor read it, run this in your coding session:', r.command, doc);
  } catch (err) {
    showToast(`Couldn't send that: ${/** @type {Error} */ (err).message}`, undefined, doc);
  }
}

/** @param {any} q One question with its answer, the outcome and Menitor's reply. */
function pastQuestion(q) {
  return h(
    'li',
    { class: 'past' },
    h('p', { class: 'past-q' }, q.text),
    q.answer ? h('p', { class: 'past-a' }, q.answer.text) : h('p', { class: 'empty' }, 'Answered in your session.'),
    h('p', { class: `finding ${q.outcome === 'good' ? 'good' : ''}` }, q.outcome === 'good' ? 'Good answer' : 'Not quite yet'),
    q.feedback ? h('p', { class: 'feedback', 'data-m': `fb:${q.id}` }, q.feedback) : null,
  );
}

/** @param {any} s C-5, C-6: the explain-back questions, answered right here. */
function questionPanel(s) {
  const open = openQuestion(s);
  const past = (s.questions ?? []).filter((/** @type {any} */ q) => q.outcome !== null);
  /** @type {(Node | null)[]} */
  const main = [h('header', { class: 'panel-head' }, h('h2', { id: 'qa-title' }, 'Explain your code'), open ? h('span', { class: 'count' }, open.try === 1 ? 'One question' : 'One more question') : null)];
  if (open) {
    main.push(h('p', { class: 'question', 'data-m': `q:${open.id}` }, open.text));
    if (open.answer && !editing.has(open.id)) {
      main.push(
        h('div', { class: 'answer' }, h('p', { class: 'answer-text' }, open.answer.text)),
        h(
          'div',
          { class: 'qa-actions' },
          h('p', { class: 'how' }, `Sent at ${clock(open.answer.at)}. Menitor replies here.`),
          h('button', { type: 'button', class: 'btn secondary small', 'data-key': `edit:${open.id}`, onclick: () => (editing.add(open.id), drafts.set(open.id, open.answer.text), render(state)) }, 'Change answer'),
        ),
      );
    } else {
      const helpId = `help-${open.id}`;
      const box = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: `answer-${open.id}`, rows: 4, maxlength: 4000, 'aria-describedby': helpId, 'data-key': `answer:${open.id}` }));
      box.value = drafts.get(open.id) ?? '';
      box.addEventListener('input', () => drafts.set(open.id, box.value));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendAnswer(open, box, e);
      });
      main.push(
        h('label', { class: 'field-label', for: `answer-${open.id}` }, 'Your answer'),
        h('p', { class: 'field-help', id: helpId }, 'In your own words. A sentence or two is enough.'),
        box,
        h('div', { class: 'qa-actions' }, h('p', { class: 'how' }, 'You can answer in your session instead.'), h('button', { type: 'button', class: 'btn primary', 'data-key': `send:${open.id}`, onclick: (/** @type {Event} */ e) => sendAnswer(open, box, e) }, 'Send answer')),
      );
    }
  }
  const side = past.length ? h('div', { class: 'qa-side' }, h('h3', null, 'Earlier'), h('ol', { class: 'past-list' }, ...past.map(pastQuestion))) : null;
  return h('section', { class: 'panel qa', 'aria-labelledby': 'qa-title' }, h('div', { class: 'qa-main' }, ...main), side);
}

/** @param {any} s Everything that waits on someone before the next task, in the order it matters. */
function turnView(s) {
  const c = s.card;
  const cmd = (/** @type {string} */ k, /** @type {string} */ fallback) => s.commands?.[k] ?? fallback;
  /** @type {Node[]} */
  const nodes = [];
  if (s.waiting) {
    const waiting = callout('you', 'Menitor is waiting on you', s.waiting.text);
    waiting.dataset.m = 'waiting';
    nodes.push(waiting);
  }
  if (c.owner === 'delegated') {
    const asked = s.goAskedAt;
    nodes.push(
      callout(
        'menitor',
        "Menitor's turn",
        asked
          ? `Asked at ${clock(asked)}. Menitor is working on this task; your next one shows here when it's done.`
          : `${c.skipped ? 'You skipped this task' : 'This task is outside your focus areas'}, so Menitor does it. Start it, and your next task shows here when it's done.`,
        pressButton(s, 'go', asked ? 'Ask again' : 'Start it', asked ? 'secondary' : 'primary'),
      ),
    );
  }
  if (s.skipRequested) {
    const confirm = `${cmd('skip', '/menitor:skip')} --confirm`;
    nodes.push(
      callout(
        'you',
        'You asked to skip this task',
        'Only you can hand it over: type this in your session. Or keep going here.',
        h('code', { class: 'command' }, confirm),
        h('button', { type: 'button', class: 'btn secondary small', 'data-key': 'copy:skip', onclick: (/** @type {Event} */ e) => copyCommand(confirm, e) }, 'Copy'),
      ),
    );
  }
  if ((s.questions ?? []).length) nodes.push(questionPanel(s));
  return nodes.length ? [h('div', { class: 'turn' }, ...nodes)] : [];
}

/**
 * Type-along refuses copying: the learner types the code by hand. It's friction, not secrecy.
 * @param {Event} e
 */
function noCopy(e) {
  e.preventDefault();
  if (e.type === 'selectstart' || e.type === 'dragstart') return;
  const now = Date.now();
  if (now - lastNudge < 2500) return;
  lastNudge = now;
  showToast('Type it in yourself. Typing it is how it sticks.', undefined, docOf(e));
}

/** @param {Element} el */
function guardCopy(el) {
  for (const type of ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart']) el.addEventListener(type, noCopy);
  el.addEventListener('keydown', (e) => {
    const k = /** @type {KeyboardEvent} */ (e);
    if ((k.ctrlKey || k.metaKey) && ['c', 'x', 'a'].includes(k.key.toLowerCase())) noCopy(e);
  });
}

/**
 * A copy that would carry step code out of a page-wide selection is refused too.
 * @param {Document} doc
 */
function guardDocumentCopy(doc) {
  doc.addEventListener('copy', (e) => {
    const sel = doc.getSelection();
    if (sel && [...doc.querySelectorAll('.code')].some((el) => sel.containsNode(el, true))) noCopy(e);
  });
}

/**
 * One block of code to type, with line numbers to keep your place.
 * @param {{ where?: string, text: string }} block
 */
function codeBlock(block) {
  const where = block.where ?? 'Terminal';
  const code = h('code');
  for (const line of block.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) code.append(h('span', { class: 'ln' }, line));
  const pre = h('pre', { tabindex: '0', 'aria-label': `Code to type in ${where}` }, code);
  const fig = h('figure', { class: 'code' }, h('figcaption', { class: `where${/[/.]/.test(where) ? ' path' : ''}` }, where), pre);
  guardCopy(fig);
  return fig;
}

/**
 * Keep the open step in step with the ticks: ticking a step closes it and opens the next.
 * @param {any} c
 */
function syncAccordion(c) {
  const current = c.checklist.find((/** @type {any} */ i) => !i.ticked)?.id ?? null;
  if (accordion.task !== c.task) {
    accordion = { task: c.task, current, open: new Set(current ? [current] : []) };
    return;
  }
  if (accordion.current === current) return;
  accordion.current = current;
  accordion.open = new Set(current ? [current] : []);
}

/**
 * Type-along steps: each one a row that opens to its instructions and the code to type.
 * @param {any} c
 * @param {any} s
 */
function typeAlongPanel(c, s) {
  syncAccordion(c);
  const ticked = c.checklist.filter((/** @type {any} */ i) => i.ticked).length;
  const list = h('ol', { class: 'checklist inner typealong' });
  c.checklist.forEach((/** @type {any} */ item, /** @type {number} */ i) => {
    const step = s.typeAlong.steps[item.id] ?? { missing: true };
    const locked = Boolean(step.locked);
    const expanded = !locked && accordion.open.has(item.id);
    const textId = `step-${item.id}`;
    const panelId = `code-${item.id}`;
    const canTick = item.ticked || i === 0 || c.checklist[i - 1].ticked;
    const box = /** @type {HTMLInputElement} */ (
      h('input', { type: 'checkbox', checked: item.ticked, disabled: !canTick, 'aria-labelledby': textId, 'data-key': `tick:${item.id}` })
    );
    box.addEventListener('change', () => {
      revealNext = box.checked;
      onTick(item.id, box);
    });
    const toggle = h(
      'button',
      { type: 'button', class: 'disclose', 'aria-expanded': String(expanded), 'aria-controls': panelId, disabled: locked, 'data-key': `open:${item.id}` },
      h('span', { class: 'text', id: textId }, item.text, item.source === 'fix' ? h('span', { class: 'pill negative' }, 'Fix') : null),
      locked ? h('span', { class: 'sr-only' }, ', opens once the step before is ticked') : null,
      h('span', { class: 'chev', 'aria-hidden': 'true' }),
    );
    toggle.addEventListener('click', () => {
      if (accordion.open.has(item.id)) accordion.open.delete(item.id);
      else accordion.open.add(item.id);
      render(state);
    });
    /** @type {(Node | null)[]} */
    const body = [];
    if (step.missing) body.push(h('p', { class: 'empty' }, 'No code for this step yet. Ask Menitor in your session to write it.'));
    if (step.say) body.push(h('p', { class: 'say' }, step.say));
    for (const block of step.code ?? []) body.push(codeBlock(block));
    list.append(
      h(
        'li',
        { class: `item step${item.ticked ? ' done' : ''}${locked ? ' locked' : ''}${expanded ? ' expanded' : ''}`, 'data-m': `item:${item.id}` },
        h('div', { class: 'step-row', 'data-m': `tick:${item.id}` }, box, toggle),
        h('div', { class: 'solution', id: panelId, hidden: !expanded }, ...body),
      ),
    );
  });
  return h(
    'section',
    { class: 'panel steps', 'aria-labelledby': 'steps-title' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', { id: 'steps-title' }, 'Steps'),
      h('span', { class: 'count num' }, `${ticked} of ${c.checklist.length} done`),
      h('span', { class: 'pill neutral' }, 'Type-along'),
    ),
    list,
    h('div', { class: 'done-when' }, h('h3', null, 'Done when'), h('ul', null, ...c.doneWhen.map((/** @type {string} */ d) => h('li', null, d)))),
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
        { class: `item${item.ticked ? ' done' : ''}${learner ? '' : ' readonly'}`, 'data-m': `item:${item.id}` },
        h('label', { 'data-m': `tick:${item.id}` }, box, h('span', { class: 'text' }, item.text, item.source === 'fix' ? h('span', { class: 'pill negative' }, 'Fix') : null)),
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
    rungs.forEach((/** @type {any} */ r, /** @type {number} */ i) => ladder.append(h('li', { class: `rung${r.open ? ' open' : ''}`, 'data-m': `rung:${i}` }, RUNGS[r.rung] ?? r.rung, h('span', { class: 'sr-only' }, r.open ? ' (open)' : ' (locked)'))));
    side.push(ladder);
    for (const r of rungs) {
      if (!r.open || !r.text) continue;
      const text = CODE_RUNGS.has(r.rung) ? h('pre', null, h('code', null, r.text)) : h('p', null, r.text);
      body.push(h('div', { class: 'hint', 'data-m': `hint:${r.rung}` }, h('h3', null, RUNGS[r.rung] ?? r.rung), text));
    }
    if (revealed === 0) body.push(h('p', { class: 'empty hint' }, 'None open yet. The first one is the idea, never the code.'));
    if (!body.length) body.push(h('p', { class: 'empty' }, 'None open yet.'));
    if (revealed === rungs.length) body.push(h('p', { class: 'note' }, "All four are open. If you're still stuck, debug it together."));
  }
  return h('section', { class: 'panel hints', 'aria-labelledby': 'hints-title' }, h('div', { class: 'hints-side' }, ...side), h('div', { class: 'hints-body' }, ...body));
}

/**
 * What to read first, the doc section the task builds, and its branch.
 * @param {any} c
 * @param {string} [title]
 */
function learnPanel(c, title = 'Before you code') {
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
  return h('section', { class: 'panel learn', 'aria-labelledby': 'learn-title' }, h('header', { class: 'panel-head' }, h('h2', { id: 'learn-title' }, title)), learn, kv);
}

const KIND_WORDS = /** @type {Record<string, string>} */ ({
  you: 'done, written by you',
  menitor: 'done by Menitor',
  skipped: 'done by Menitor after you skipped it',
  now: 'the current task',
  todo: 'to do',
});

/** @param {any} t A task in the ledger: who did it, or where it stands. */
function kindOf(t) {
  return t.current ? 'now' : !t.done ? 'todo' : t.skipped ? 'skipped' : t.by === 'learner' ? 'you' : 'menitor';
}

/** @param {any} m One milestone: its name, how far it is, and a cell per task. */
function milestoneRow(m) {
  const cells = h('ol', { class: 'cells' });
  for (const t of m.tasks ?? []) {
    const kind = kindOf(t);
    const added = t.added ? ' (added later)' : '';
    const label = `Task ${t.number}${added}, ${t.goal}: ${KIND_WORDS[kind]}`;
    const viewing = finished?.id === t.id;
    // A finished task opens to look back on; the others are only marks.
    const mark = t.done
      ? h('button', { type: 'button', class: 'cell-open', 'data-key': `cell:${t.id}`, 'aria-label': label, 'aria-current': viewing ? 'true' : undefined, onclick: (/** @type {Event} */ e) => openFinished(t.id, e) })
      : h('span', { class: 'sr-only' }, label);
    cells.append(h('li', { class: `cell ${kind}${t.added ? ' added' : ''}${viewing ? ' viewing' : ''}`, title: `Task ${t.number}${added}: ${t.goal}`, 'data-m': `cell:${t.id}` }, mark));
  }
  return h(
    'li',
    { class: `ms${m.current ? ' current' : ''}`, 'data-m': `ms:${m.id}` },
    h('span', { class: 'ms-name', title: m.title }, m.title),
    h('span', { class: 'ms-count', 'aria-label': `${m.done} of ${m.total} done` }, `${m.done}/${m.total}`),
    cells,
  );
}

/**
 * Milestones folded into one row: the ones done, or the ones still to come. Every task still
 * shows, as a small cell, and the row opens to the full milestones.
 * @param {'done' | 'later'} which
 * @param {any[]} ms
 */
function foldRow(which, ms) {
  const open = planOpen[which];
  const tasks = ms.flatMap((m) => m.tasks ?? []);
  const done = tasks.filter((t) => t.done).length;
  return h(
    'li',
    { class: `ms fold${open ? ' open' : ''}` },
    h(
      'button',
      { type: 'button', class: 'fold-toggle', 'aria-expanded': String(open), 'data-key': `fold:${which}`, onclick: () => togglePlanGroup(which) },
      h('span', { class: 'ms-name' }, which === 'done' ? `${ms.length} milestones done` : `${ms.length} more milestones`),
      h('span', { class: 'ms-count num', 'aria-hidden': 'true' }, `${done}/${tasks.length}`),
      h('span', { class: 'sr-only' }, `, ${done} of ${plural(tasks.length, 'task')} done`),
      h('span', { class: 'chev', 'aria-hidden': 'true' }),
      open ? null : h('span', { class: 'cells mini', 'aria-hidden': 'true' }, ...tasks.map((t) => h('span', { class: `cell ${kindOf(t)}` }))),
    ),
  );
}

/** @param {'done' | 'later'} which Open or fold a group of milestones, and remember it here. */
function togglePlanGroup(which) {
  planOpen = { ...planOpen, [which]: !planOpen[which] };
  try {
    localStorage.setItem('menitor.plan-open', JSON.stringify(planOpen));
  } catch {
    // Not kept between visits; it still works now.
  }
  if (planOpen[which]) markPlanGroup(which);
  render(state);
}

/**
 * W-8, the signature element: every task in the plan as one cell, marked by who did it. While a
 * task is current, the milestones before and after its own fold into a row each, so the card keeps
 * its size however long the plan grows.
 * @param {any} s
 * @param {{ full?: boolean }} [options] full: every milestone on its own row
 */
function planPanel(s, options = {}) {
  const counts = /** @type {Record<string, number>} */ ({ you: 0, menitor: 0, skipped: 0, now: 0, todo: 0, added: 0 });
  for (const m of s.milestones) {
    for (const t of m.tasks ?? []) {
      counts[kindOf(t)] += 1;
      if (t.added) counts.added += 1;
    }
  }
  const rows = h('ol', { class: 'ledger' });
  const current = options.full ? -1 : s.milestones.findIndex((/** @type {any} */ m) => m.current);
  // A group folds only when it holds two milestones or more: one folded row for one row saves nothing.
  const groups = current < 0 ? [] : [{ which: /** @type {const} */ ('done'), from: 0, to: current }, { which: /** @type {const} */ ('later'), from: current + 1, to: s.milestones.length }].filter((g) => g.to - g.from >= 2);
  let shownDone = 0;
  for (let i = 0; i < s.milestones.length; i++) {
    const g = groups.find((x) => x.from === i);
    if (g) {
      rows.append(foldRow(g.which, s.milestones.slice(g.from, g.to)));
      if (!planOpen[g.which]) {
        i = g.to - 1;
        continue;
      }
    }
    shownDone += s.milestones[i].tasks.filter((/** @type {any} */ t) => t.done).length;
    rows.append(milestoneRow(s.milestones[i]));
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
  key('added', 'Added later');
  return h(
    'section',
    { class: 'panel plan', 'aria-labelledby': 'plan-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'plan-title' }, 'Plan'), h('span', { class: 'count num' }, `${s.done} of ${plural(s.total, 'task')} done`)),
    rows,
    legend,
    shownDone ? h('p', { class: 'ledger-tip' }, 'Select a finished task to look back on it.') : null,
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
      h('h1', { id: 'title', tabindex: '-1' }, c.goal),
      h(
        'p',
        { class: 'status' },
        h('span', { class: 'num' }, `Task ${c.number} of ${c.total} · ${c.milestone.title}`),
        c.added ? h('span', { class: 'tag', title: `Added to the plan on ${new Date(c.added).toLocaleDateString()}` }, 'Added') : null,
        h('span', { class: `finding ${f.tone}`, 'data-m': 'finding' }, f.text),
      ),
      h('p', { class: 'why' }, c.why),
    ),
    learner ? actions(s) : null,
  );
  // DOM order is the phone's reading order: steps, hints, then the rail. Desktop places the rail beside the steps.
  const typeAlong = learner && s.typeAlong;
  // DOM order is the reading order on a phone: before you code, the steps, hints, then the plan.
  // On a desktop the grid puts before you code and the plan in the right-hand column.
  // The to-dos have a tab of their own, so the board holds only the task and where it sits.
  const board = h(
    'div',
    { class: `board${typeAlong ? ' typealong' : ''}` },
    learnPanel(c, learner ? 'Before you code' : 'Read more'),
    typeAlong ? typeAlongPanel(c, s) : stepsPanel(c),
    learner && !typeAlong ? hintsPanel(c) : null,
    planPanel(s),
  );
  return { nodes: [head, ...turnView(s), board], bar: learner };
}

/**
 * C-6: Continue from a passed task's result to the next card. The server remembers it, so a
 * reload or the pop-out moves on too.
 * @param {any} r the result on screen
 * @param {Event} e
 */
async function continueOn(r, e) {
  const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
  btn.disabled = true;
  try {
    const next = await post('/api/continue', { task: r.task });
    withTransition(() => render(next));
  } catch (err) {
    btn.disabled = false;
    showToast(`Couldn't move on: ${/** @type {Error} */ (err).message}`, undefined, docOf(e));
  }
}

/**
 * The explain-back questions, each with the learner's answer and Menitor's reply (C-6).
 * @param {any[]} questions
 */
function explainList(questions) {
  return h(
    'ol',
    { class: 'result-list' },
    ...questions.map((/** @type {any} */ q) =>
      h(
        'li',
        { class: 'result-item' },
        h('p', { class: 'past-q' }, q.text),
        q.answer ? h('p', { class: 'past-a' }, q.answer.text) : h('p', { class: 'empty' }, 'Answered in your session.'),
        h('p', { class: `finding ${q.outcome === 'good' ? 'good' : ''}` }, q.outcome === 'good' ? 'Good answer' : 'Not quite yet'),
        q.feedback ? h('p', { class: 'result-feedback', 'data-m': `fb:${q.id}` }, q.feedback) : null,
      ),
    ),
  );
}

/** The finished task the learner opened from the plan, as the server sent it. */
let finished = /** @type {{ id: string, data: any } | null} */ (null);

/** Keep the open view in the address (a finished task, or the to-dos), so a reload shows it again. */
function syncHash() {
  const want = finished ? `#task=${finished.id}` : tab === 'todos' ? '#todos' : '';
  if (location.hash === want) return;
  try {
    history.replaceState(null, '', want || `${location.pathname}${location.search}`);
  } catch {
    // Nothing to keep it in.
  }
}

/**
 * Open a finished task to look back on. Done tasks never change, so the window asks for one only
 * when the learner opens it.
 * @param {string} id
 * @param {Event} [e]
 */
async function openFinished(id, e) {
  try {
    const res = await fetch(`/api/task?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    const stepping = Boolean(finished);
    const data = await res.json();
    if (!state) {
      finished = { id, data };
      syncHash();
      return;
    }
    withTransition(() => {
      finished = { id, data };
      syncHash();
      render(state);
      // Opened from the plan, the keyboard moves to the task; Previous and Next keep it where it is.
      // Opened from a link, nothing was pressed, so focus stays put.
      const doc = content.ownerDocument;
      if (!e) return;
      if (!stepping || !content.contains(doc.activeElement) || /** @type {HTMLButtonElement} */ (doc.activeElement).disabled) {
        /** @type {HTMLElement | null} */ (content.querySelector('#title'))?.focus();
      }
    });
  } catch (err) {
    if (!finished) syncHash();
    showToast(`Couldn't open that task: ${/** @type {Error} */ (err).message}`, undefined, docOf(e));
  }
}

/** Back to where the learner was, with the keyboard on the task they had open. */
function closeFinished() {
  const id = finished?.id ?? '';
  if (!state) {
    finished = null;
    syncHash();
    return;
  }
  withTransition(() => {
    finished = null;
    syncHash();
    render(state);
    // Back on the cell or the list row it was opened from; a cell in a folded group isn't there, so the title.
    const from = content.querySelector(`[data-key="cell:${CSS.escape(id)}"], [data-key="built:${CSS.escape(id)}"]`) ?? content.querySelector('#title');
    /** @type {HTMLElement | null} */ (from)?.focus();
  });
}

/** @param {any} t Who did a task, in words. */
function whoDid(t) {
  if (t.owner === 'learner') return 'Written by you';
  return t.skipped ? 'You skipped it, so Menitor did it' : 'Done by Menitor';
}

/**
 * A finished task, opened from the plan to look back on: who did it, its steps and fixes, the
 * notes, the explanation and the hints opened. Nothing here can be changed.
 * @param {any} s
 * @param {any} t
 */
function finishedView(s, t) {
  const learner = t.owner === 'learner';
  const nav = h(
    'nav',
    { class: 'history-nav', 'aria-label': 'Finished tasks' },
    h('button', { type: 'button', class: 'btn secondary small', 'data-key': 'history:back', onclick: closeFinished }, s.card && !s.result ? `Back to task ${s.card.number}` : 'Back'),
    h('button', { type: 'button', class: 'btn ghost small', 'data-key': 'history:prev', 'aria-label': 'Previous finished task', disabled: !t.prev, onclick: (/** @type {Event} */ e) => t.prev && openFinished(t.prev, e) }, 'Previous'),
    h('button', { type: 'button', class: 'btn ghost small', 'data-key': 'history:next', 'aria-label': 'Next finished task', disabled: !t.next, onclick: (/** @type {Event} */ e) => t.next && openFinished(t.next, e) }, 'Next'),
  );
  const head = h(
    'header',
    { class: 'head history-head' },
    h(
      'div',
      { class: 'head-text' },
      h('h1', { id: 'title', tabindex: '-1' }, t.goal),
      h(
        'p',
        { class: 'status' },
        h('span', { class: 'num' }, `Task ${t.number} of ${t.total} · ${t.milestone.title}`),
        t.added ? h('span', { class: 'tag' }, 'Added') : null,
        h('span', { class: 'finding good' }, t.passedAt ? `Passed ${day(t.passedAt)}` : 'Passed'),
        h('span', null, whoDid(t)),
      ),
      h('p', { class: 'why' }, t.why),
    ),
    nav,
  );
  const fixes = t.checklist.filter((/** @type {any} */ i) => i.source === 'fix').length;
  const steps = h(
    'section',
    { class: 'panel history-steps', 'aria-labelledby': 'steps-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'steps-title' }, 'Steps'), h('span', { class: 'count num' }, fixes ? `${plural(t.checklist.length, 'step')}, ${plural(fixes, 'fix', 'fixes')} after a check` : plural(t.checklist.length, 'step'))),
    h('ol', { class: 'history-list' }, ...t.checklist.map((/** @type {any} */ i) => h('li', null, h('span', null, i.text), i.source === 'fix' ? h('span', { class: 'pill negative' }, 'Fix') : null))),
    h('div', { class: 'done-when' }, h('h3', null, 'Done when'), h('ul', null, ...t.doneWhen.map((/** @type {string} */ d) => h('li', null, d)))),
    t.note ? h('div', { class: 'history-note' }, h('h3', null, 'Note'), h('p', null, t.note)) : null,
  );
  const explain = learner
    ? h(
        'section',
        { class: 'panel result', 'aria-labelledby': 'explain-title' },
        h('header', { class: 'panel-head' }, h('h2', { id: 'explain-title' }, 'Your explanation')),
        t.questions.length ? explainList(t.questions) : h('p', { class: 'empty' }, 'No explain-back questions on this task.'),
        t.revisit.length ? h('p', { class: 'note' }, `To revisit: ${t.revisit.join(', ')}`) : null,
      )
    : null;
  const opened = t.hints.rungs.filter((/** @type {any} */ r) => r.open && r.text);
  const hints =
    learner && t.hints.stored
      ? h(
          'section',
          { class: 'panel history-hints', 'aria-labelledby': 'hints-title' },
          h('header', { class: 'panel-head' }, h('h2', { id: 'hints-title' }, 'Hints'), h('span', { class: 'count num' }, `${t.hints.revealed} of ${t.hints.rungs.length} opened`)),
          ...(opened.length
            ? opened.map((/** @type {any} */ r) => h('div', { class: 'hint' }, h('h3', null, RUNGS[r.rung] ?? r.rung), CODE_RUNGS.has(r.rung) ? h('pre', null, h('code', null, r.text)) : h('p', null, r.text)))
            : [h('p', { class: 'empty' }, 'You opened no hints on this task.')]),
        )
      : null;
  const main = h('div', { class: 'history-main' }, steps, explain, hints);
  const side = h('div', { class: 'history-side' }, learnPanel(t, 'Read more'), planPanel(s, { full: true }));
  return { nodes: [head, h('div', { class: 'history-body' }, main, side)], bar: false };
}

/**
 * C-6: what Menitor said about the learner's explain-back on the task that just passed. It stays
 * until they press Continue, so the next card never replaces feedback they haven't read.
 * @param {any} s
 */
function resultView(s) {
  const r = s.result;
  const head = h(
    'header',
    { class: 'head' },
    h(
      'div',
      { class: 'head-text' },
      h('h1', { id: 'title', tabindex: '-1' }, r.goal),
      h('p', { class: 'status' }, h('span', { class: 'num' }, `Task ${r.number} of ${s.total}`), h('span', { class: 'finding good' }, 'Passed')),
    ),
  );
  const said = h(
    'section',
    { class: 'panel result', 'aria-labelledby': 'result-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'result-title' }, 'Your explanation')),
    explainList(r.questions),
  );
  const nextText = r.next ? `Task ${r.next.number} of ${s.total}: ${r.next.goal}` : 'That was the last task in your plan.';
  const next = callout(
    'you',
    'Up next',
    nextText,
    h('button', { type: 'button', class: 'btn primary', 'data-key': `continue:${r.task}`, onclick: (/** @type {Event} */ e) => continueOn(r, e) }, r.next ? `Continue to task ${r.next.number}` : 'Continue'),
  );
  // The plan ledger shows the pass as progress: the task just done is filled in. On a desktop it
  // sits in the right-hand column, as on the task card.
  return { nodes: [head, h('div', { class: 'result-body' }, h('div', { class: 'result-main' }, said, next), planPanel(s))], bar: false };
}

/**
 * Setup: tell the session the warm-up code is written. A fixed event; nothing else is sent.
 * @param {Event} e
 */
async function onWarmupDone(e) {
  const doc = docOf(e);
  try {
    const r = await post('/api/event', { type: 'warmup-done' });
    showToast(r.delivered ? 'Sent. Menitor is reading your code now.' : "Menitor isn't listening right now. Tell your session you're done.", undefined, doc);
  } catch (err) {
    showToast(`That didn't work: ${/** @type {Error} */ (err).message}`, undefined, doc);
  }
}

/**
 * Setup: send the answer to the warm-up question. It's saved as data; the session only hears
 * that it arrived.
 * @param {HTMLTextAreaElement} box
 * @param {Event} e
 */
async function sendWarmupAnswer(box, e) {
  const doc = docOf(e);
  const text = box.value.trim();
  if (!text) {
    showToast('Write your answer first, in your own words.', undefined, doc);
    box.focus();
    return;
  }
  try {
    const r = await post('/api/setup-answer', { key: 'warmup-answer', text });
    drafts.delete('warmup');
    editing.delete('warmup');
    render(r.state);
    if (!r.delivered) showToast("Saved. Menitor isn't listening right now, so tell your session you've answered.", undefined, doc);
  } catch (err) {
    showToast(`That didn't work: ${/** @type {Error} */ (err).message}`, undefined, doc);
  }
}

/**
 * A line of text with its `inline code` set as code. Built from text nodes, so nothing runs.
 * @param {string} tag
 * @param {string} text
 */
function withCode(tag, text) {
  const parts = text.split(/`([^`]+)`/);
  return h(tag, null, ...parts.map((part, i) => (i % 2 ? h('code', null, part) : part)));
}

/**
 * The warm-up as the page draws it: text blocks only, never markup. List items group into a list.
 * @param {{ kind: string, text: string }[]} blocks
 */
function warmupText(blocks) {
  /** @type {Node[]} */
  const nodes = [];
  /** @type {HTMLElement | null} */
  let list = null;
  for (const b of blocks) {
    if (b.kind === 'item') {
      if (!list) nodes.push((list = h('ul', { class: 'warmup-list' })));
      list.append(withCode('li', b.text));
      continue;
    }
    list = null;
    if (b.kind === 'heading') nodes.push(withCode('h3', b.text));
    else if (b.kind === 'code') nodes.push(h('pre', null, h('code', null, b.text)));
    else nodes.push(withCode('p', b.text));
  }
  return h('div', { class: 'warmup-text' }, ...nodes);
}

/**
 * Setup's warm-up: the exercise, then "I'm done", then Menitor's question with an answer box.
 * @param {any} s
 */
function warmupPanel(s) {
  const w = s.setup.warmup;
  // The exercise's own first heading names the panel, so "Warm-up" isn't said twice.
  const blocks = /** @type {{ kind: string, text: string }[]} */ (w.exercise ?? []);
  const title = blocks[0]?.kind === 'heading' ? blocks[0].text : 'Warm-up';
  const body = blocks[0]?.kind === 'heading' ? blocks.slice(1) : blocks;
  /** @type {(Node | null)[]} */
  const parts = [h('header', { class: 'panel-head' }, h('h2', { id: 'warmup-title' }, title), h('span', { class: 'count' }, '10 minutes or less'))];
  if (body.length) parts.push(warmupText(body));
  if (!w.question) {
    parts.push(
      h(
        'div',
        { class: 'qa-actions' },
        h('p', { class: 'how' }, 'Write your answer in .menitor/warmup/, then let Menitor know.'),
        h('button', { type: 'button', class: 'btn primary', 'data-key': 'act:warmup-done', onclick: onWarmupDone }, "I'm done"),
      ),
    );
  } else if (w.answer && !editing.has('warmup')) {
    parts.push(
      h('p', { class: 'question' }, w.question),
      h('div', { class: 'answer' }, h('p', { class: 'answer-text' }, w.answer.text)),
      h(
        'div',
        { class: 'qa-actions' },
        h('p', { class: 'how' }, `Sent at ${clock(w.answer.at)}. Menitor replies in your session.`),
        h('button', { type: 'button', class: 'btn secondary small', 'data-key': 'edit:warmup', onclick: () => (editing.add('warmup'), drafts.set('warmup', w.answer.text), render(state)) }, 'Change answer'),
      ),
    );
  } else {
    const box = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: 'answer-warmup', rows: 4, maxlength: 4000, 'aria-describedby': 'help-warmup', 'data-key': 'answer:warmup' }));
    box.value = drafts.get('warmup') ?? '';
    box.addEventListener('input', () => drafts.set('warmup', box.value));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendWarmupAnswer(box, e);
    });
    parts.push(
      h('p', { class: 'question' }, w.question),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field-label', for: 'answer-warmup' }, 'Your answer'),
        h('p', { class: 'field-help', id: 'help-warmup' }, 'In your own words. A sentence or two is enough.'),
        box,
      ),
      h('div', { class: 'qa-actions' }, h('p', { class: 'how' }, 'You can answer in your session instead.'), h('button', { type: 'button', class: 'btn primary', 'data-key': 'send:warmup', onclick: (/** @type {Event} */ e) => sendWarmupAnswer(box, e) }, 'Send answer')),
    );
  }
  return h('section', { class: 'panel warmup', 'aria-labelledby': 'warmup-title' }, ...parts);
}

/**
 * Setup: save a pick at once, without waking the session, or confirm with notify.
 * @param {string} key
 * @param {string} text
 * @param {boolean} notify
 * @param {Event} e
 */
async function saveChoice(key, text, notify, e) {
  const doc = docOf(e);
  try {
    const r = await post('/api/setup-answer', { key, text, notify });
    render(r.state);
    if (notify) showToast(r.delivered ? 'Sent. Menitor carries on in your session.' : "Saved. Menitor isn't listening right now, so tell your session you've chosen.", undefined, doc);
  } catch (err) {
    showToast(`That didn't save: ${/** @type {Error} */ (err).message}`, undefined, doc);
  }
}

/**
 * Setup's choices: the stacks offered, side by side with their reasons, and the focus areas.
 * Each pick saves at once; Confirm tells the session.
 * @param {any} s
 */
function choicesPanel(s) {
  const c = s.setup.choices;
  /** @type {Node[]} */
  const parts = [h('header', { class: 'panel-head' }, h('h2', { id: 'choices-title' }, 'Your choices'))];
  if (c.stack) {
    parts.push(
      h(
        'fieldset',
        null,
        h('legend', null, 'Stack'),
        h(
          'div',
          { class: 'stack-options' },
          ...c.stack.options.map((/** @type {any} */ o, /** @type {number} */ i) =>
            h(
              'label',
              { class: `stack-option${c.stack.chosen === o.name ? ' selected' : ''}` },
              h(
                'span',
                { class: 'stack-top' },
                h('input', { type: 'radio', name: 'stack', value: o.name, checked: c.stack.chosen === o.name, 'data-key': `stack:${i}`, onchange: (/** @type {Event} */ e) => saveChoice('stack-choice', o.name, false, e) }),
                h('span', { class: 'stack-name' }, o.name),
                i === 0 ? h('span', { class: 'tag' }, 'Recommended') : null,
              ),
              o.hosting ? h('span', { class: 'stack-hosting' }, `Hosting: ${o.hosting}`) : null,
              h('ul', { class: 'stack-reasons' }, ...o.reasons.map((/** @type {string} */ r) => h('li', null, r))),
            ),
          ),
        ),
      ),
    );
  }
  if (c.focus) {
    const picked = new Set(c.focus.chosen);
    const save = (/** @type {Event} */ e) => {
      const boxes = /** @type {NodeListOf<HTMLInputElement>} */ (docOf(e).querySelectorAll('input[name="focus"]'));
      const areas = [...boxes].filter((b) => b.checked).map((b) => b.value);
      if (areas.length) saveChoice('focus', areas.join(','), false, e);
    };
    parts.push(
      h(
        'fieldset',
        null,
        h('legend', null, 'Focus areas'),
        h('p', { class: 'field-help' }, 'What you want to learn. Menitor does the tasks outside these and leaves you a note.'),
        h(
          'div',
          { class: 'focus-options' },
          ...c.focus.options.map((/** @type {string} */ area, /** @type {number} */ i) =>
            h('label', { class: `focus-option${picked.has(area) ? ' selected' : ''}` }, h('input', { type: 'checkbox', name: 'focus', value: area, checked: picked.has(area), 'data-key': `focus:${i}`, onchange: save }), area),
          ),
        ),
      ),
    );
  }
  const ready = (!c.stack || c.stack.chosen) && (!c.focus || c.focus.chosen.length > 0);
  const confirm = (/** @type {Event} */ e) => {
    if (c.stack && c.focus) {
      saveChoice('stack-choice', c.stack.chosen, false, e).then(() => saveChoice('focus', c.focus.chosen.join(','), true, e));
    } else if (c.stack) saveChoice('stack-choice', c.stack.chosen, true, e);
    else saveChoice('focus', c.focus.chosen.join(','), true, e);
  };
  parts.push(
    h(
      'div',
      { class: 'qa-actions' },
      h('p', { class: 'how' }, 'Each pick is saved as you make it.'),
      h('button', { type: 'button', class: 'btn primary', 'data-key': 'act:confirm-choices', disabled: !ready, onclick: confirm }, 'Confirm choices'),
    ),
  );
  return h('section', { class: 'panel choices', 'aria-labelledby': 'choices-title' }, ...parts);
}

/** A PRD draft saves after this pause in typing. */
const SAVE_PAUSE_MS = 800;
/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const saveTimers = new Map();

/**
 * Save a PRD section after a pause in typing, as data. The session isn't woken.
 * @param {string} key such as "prd-users"
 * @param {HTMLTextAreaElement} box
 */
function queueDraftSave(key, box) {
  clearTimeout(saveTimers.get(key));
  saveTimers.set(
    key,
    setTimeout(async () => {
      const text = box.value.trim();
      if (!text) return;
      try {
        await post('/api/setup-answer', { key, text, notify: false });
      } catch (err) {
        showToast(`Your draft didn't save: ${/** @type {Error} */ (err).message}`, undefined, box.ownerDocument);
      }
    }, SAVE_PAUSE_MS),
  );
}

/**
 * Send the PRD core for feedback: save every section, then wake the session once.
 * @param {any} s
 * @param {Event} e
 */
async function sendPrd(s, e) {
  const doc = docOf(e);
  const sections = s.setup.prd.sections.map((/** @type {any} */ x) => ({ key: `prd-${x.key}`, text: (drafts.get(`prd-${x.key}`) ?? x.text ?? '').trim() }));
  if (sections.some((/** @type {any} */ x) => !x.text)) {
    showToast('Write all three sections first. A sentence or two each is enough.', undefined, doc);
    return;
  }
  try {
    let r;
    for (const [i, x] of sections.entries()) {
      clearTimeout(saveTimers.get(x.key));
      r = await post('/api/setup-answer', { key: x.key, text: x.text, notify: i === sections.length - 1 });
    }
    render(r.state);
    showToast(r.delivered ? 'Sent. Menitor reads your draft and replies under each section.' : "Saved. Menitor isn't listening right now, so tell your session your draft is ready.", undefined, doc);
  } catch (err) {
    showToast(`That didn't send: ${/** @type {Error} */ (err).message}`, undefined, doc);
  }
}

/**
 * Setup's PRD core: a box per section, saved as typed, with Menitor's feedback under each.
 * @param {any} s
 */
function prdPanel(s) {
  const sections = s.setup.prd.sections;
  /** @type {Node[]} */
  const parts = [h('header', { class: 'panel-head' }, h('h2', { id: 'prd-title' }, 'The core of your PRD'), h('span', { class: 'count' }, 'In your own words'))];
  for (const sec of sections) {
    const key = `prd-${sec.key}`;
    const box = /** @type {HTMLTextAreaElement} */ (h('textarea', { id: `answer-${key}`, rows: sec.key === 'features' ? 5 : 3, maxlength: 4000, 'aria-describedby': `help-${key}`, 'data-key': `answer:${key}` }));
    box.value = drafts.get(key) ?? sec.text ?? '';
    box.addEventListener('input', () => {
      drafts.set(key, box.value);
      queueDraftSave(key, box);
    });
    const feedback = sec.critique
      ? h('div', { class: 'prd-feedback' }, h('p', { class: 'prd-feedback-head' }, sec.revised ? "Menitor's feedback. You've revised since." : "Menitor's feedback"), h('p', null, sec.critique.text))
      : null;
    parts.push(h('div', { class: 'field' }, h('label', { class: 'field-label', for: box.id }, sec.label), h('p', { class: 'field-help', id: `help-${key}` }, sec.help), box, feedback));
  }
  const latest = sections.map((/** @type {any} */ x) => x.at).filter(Boolean).sort().at(-1);
  parts.push(
    h(
      'div',
      { class: 'qa-actions' },
      h('p', { class: 'how' }, latest ? `Saved at ${clock(latest)}. Drafts save as you type.` : 'Drafts save as you type.'),
      h('button', { type: 'button', class: 'btn primary', 'data-key': 'act:prd-send', onclick: (/** @type {Event} */ e) => sendPrd(s, e) }, 'Send for feedback'),
    ),
  );
  return h('section', { class: 'panel prd', 'aria-labelledby': 'prd-title' }, ...parts);
}

/**
 * Setup, while it runs: the warm-up when it starts, and which answers are saved so far.
 * @param {any} s
 */
function setupView(s) {
  const su = s.setup;
  const saved = su.steps.filter((/** @type {any} */ x) => x.done).length;
  const head = h(
    'header',
    { class: 'head' },
    h(
      'div',
      { class: 'head-text' },
      h('h1', { id: 'title', tabindex: '-1' }, 'Setup'),
      h('p', { class: 'status' }, h('span', { class: 'num' }, `${saved} of ${su.steps.length} answers saved`)),
      h('p', { class: 'why' }, 'Menitor is getting to know you and your idea. Each answer is saved as you give it, so nothing is lost if the session closes.'),
    ),
  );
  // The newest step first: setup goes warm-up, then choices, then the PRD core.
  const panels = [su.prd ? prdPanel(s) : null, su.choices ? choicesPanel(s) : null, su.warmup ? warmupPanel(s) : null].filter(Boolean);
  const main = h(
    'div',
    { class: 'setup-main' },
    ...(panels.length
      ? panels
      : [
          h(
            'section',
            { class: 'panel', 'aria-labelledby': 'setup-wait-title' },
            h('header', { class: 'panel-head' }, h('h2', { id: 'setup-wait-title' }, 'In your session')),
            h('p', null, 'Menitor is asking its questions in your coding session. The warm-up shows up here when it starts.'),
            // What they have said so far, in their own words: proof it was heard and saved.
            su.told?.length
              ? h(
                  'div',
                  { class: 'told' },
                  h('h3', null, 'What you have told Menitor'),
                  h('dl', null, ...su.told.flatMap((/** @type {any} */ x) => [h('dt', null, x.label), h('dd', { 'data-m': `told:${x.key}` }, x.value)])),
                )
              : null,
          ),
        ]),
  );
  const steps = h(
    'section',
    { class: 'panel setup-steps', 'aria-labelledby': 'setup-steps-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'setup-steps-title' }, 'Setup so far')),
    h('ol', { class: 'setup-list' }, ...su.steps.map((/** @type {any} */ x) => h('li', { class: x.done ? 'done' : '', 'data-m': `setup:${x.key}` }, h('span', null, x.label), h('span', { class: 'setup-mark' }, x.done ? 'Saved' : 'Not yet')))),
  );
  return { nodes: [head, h('div', { class: 'setup-body' }, main, steps)], bar: false };
}

/** The to-do being edited, if any. */
let editingTodo = /** @type {string | null} */ (null);

/**
 * Add, edit, tick or delete a to-do. The learner's own notes, saved as data; nothing reaches the session.
 * @param {Record<string, unknown>} body
 * @param {Event} e
 */
async function todoAction(body, e) {
  try {
    render(await post('/api/todo', body));
  } catch (err) {
    showToast(`That didn't save: ${/** @type {Error} */ (err).message}`, undefined, docOf(e));
  }
}

/**
 * Where a planned to-do went, in the words the plan uses: a task or milestone number, or a step on a task.
 * @param {any} s
 * @param {string} to a task, step or milestone ID
 */
function plannedAs(s, to) {
  const milestones = /** @type {any[]} */ (s?.milestones ?? []);
  const m = milestones.find((x) => x.id === to);
  if (m) return `In the plan as milestone ${m.number}`;
  const [taskId, step] = to.split('.');
  const task = milestones.flatMap((x) => x.tasks ?? []).find((x) => x.id === taskId);
  if (!task) return 'In the plan';
  return step ? `In the plan as a step on task ${task.number}` : `In the plan as task ${task.number}`;
}

/**
 * Send a to-do into the plan. Only its ID goes to the session, which reads the text through the CLI
 * and runs the add flow. If nothing is listening, copy the add command with the to-do's text instead.
 * @param {any} t
 * @param {Event} e
 */
async function onPlanTodo(t, e) {
  const doc = docOf(e);
  if (busyPress(state)) return;
  try {
    const r = await post('/api/event', { type: 'add', todo: t.id });
    if (r.busy) {
      showToast('Menitor is still working on your last press.', undefined, doc);
      return;
    }
    if (r.delivered) {
      localPress = { type: 'add', todo: t.id, at: new Date().toISOString(), claimedAt: null, state: 'sent', doneAt: null };
      render(state);
      return;
    }
    await copyCommand(`${r.command} ${t.text}`, e);
  } catch (err) {
    showToast(`That didn't work: ${/** @type {Error} */ (err).message}`, undefined, doc);
  }
}

/**
 * The Add to plan button on an open to-do: it shows the press while it is on its way, and waits
 * while another press is.
 * @param {any} s
 * @param {any} t
 */
function planTodoButton(s, t) {
  const busy = busyPress(s);
  const mine = busy?.type === 'add' && busy.todo === t.id;
  return h(
    'button',
    {
      type: 'button',
      class: `btn ghost small plan-todo${mine ? ' busy' : ''}`,
      'data-key': `todo-plan:${t.id}`,
      disabled: Boolean(busy && !mine),
      'aria-disabled': mine ? 'true' : undefined,
      'aria-busy': mine ? 'true' : undefined,
      'aria-label': `Add to plan: ${t.text}`,
      onclick: (/** @type {Event} */ e) => onPlanTodo(t, e),
    },
    mine ? (busy.state === 'sent' ? 'Sent' : PRESS_WORDS.add.busy) : 'Add to plan',
  );
}

/** The to-do just deleted, kept for a few seconds so a slip can be undone where it happened. */
let undoTodo = /** @type {{ text: string, done: boolean, index: number, timer: ReturnType<typeof setTimeout> } | null} */ (null);
const UNDO_MS = 8000;

/**
 * Delete a to-do, and offer to bring it back in its place for a few seconds.
 * @param {any} t
 * @param {number} index its place in the list on screen
 * @param {Event} e
 */
async function deleteTodo(t, index, e) {
  try {
    const next = await post('/api/todo', { action: 'delete', id: t.id });
    if (undoTodo) clearTimeout(undoTodo.timer);
    undoTodo = {
      text: t.text,
      done: t.done,
      index,
      timer: setTimeout(() => {
        undoTodo = null;
        if (state) render(state);
      }, UNDO_MS),
    };
    mark('todo-undo', 'm-arrive', 320);
    render(next);
    /** @type {HTMLElement | null} */ (content.querySelector('[data-key="todo-undo"]'))?.focus();
  } catch (err) {
    showToast(`That didn't save: ${/** @type {Error} */ (err).message}`, undefined, docOf(e));
  }
}

/** @param {Event} e Bring the deleted to-do back, ticked if it was. */
async function undoDelete(e) {
  const u = undoTodo;
  if (!u) return;
  clearTimeout(u.timer);
  undoTodo = null;
  try {
    let next = await post('/api/todo', { action: 'add', text: u.text });
    const back = next.todos?.at(-1);
    if (u.done && back) next = await post('/api/todo', { action: 'tick', id: back.id, done: true });
    render(next);
    if (back) /** @type {HTMLElement | null} */ (content.querySelector(`[data-key="todo-tick:${CSS.escape(back.id)}"]`))?.focus();
  } catch (err) {
    showToast(`Couldn't bring it back: ${/** @type {Error} */ (err).message}`, undefined, docOf(e));
  }
}

/** @param {{ text: string }} u Where a deleted to-do was, with Undo. */
function undoRow(u) {
  return h(
    'li',
    { class: 'todo undo', 'data-m': 'todo-undo' },
    h('p', { class: 'todo-text' }, `Deleted “${u.text}”`),
    h('div', { class: 'todo-actions' }, h('button', { type: 'button', class: 'btn ghost small', 'data-key': 'todo-undo', onclick: undoDelete }, 'Undo')),
  );
}

/**
 * One to-do: a box to tick, its text, and Add to plan, Edit and Delete. Editing swaps the text for
 * a field. A to-do the plan took says where it went.
 * @param {any} t
 * @param {number} index
 */
function todoRow(t, index) {
  if (editingTodo === t.id) {
    const field = /** @type {HTMLInputElement} */ (h('input', { type: 'text', id: `todo-edit-${t.id}`, maxlength: 500, 'data-key': `todo-edit:${t.id}` }));
    field.value = drafts.get(`todo-edit:${t.id}`) ?? t.text;
    field.addEventListener('input', () => drafts.set(`todo-edit:${t.id}`, field.value));
    const save = (/** @type {Event} */ e) => {
      e.preventDefault();
      const text = field.value.trim();
      if (!text) return;
      editingTodo = null;
      drafts.delete(`todo-edit:${t.id}`);
      todoAction({ action: 'edit', id: t.id, text }, e);
    };
    const cancel = () => {
      editingTodo = null;
      drafts.delete(`todo-edit:${t.id}`);
      render(state);
      /** @type {HTMLElement | null} */ (content.querySelector(`[data-key="todo-edit-btn:${CSS.escape(t.id)}"]`))?.focus();
    };
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      cancel();
    });
    return h(
      'li',
      { class: 'todo editing' },
      h(
        'form',
        { class: 'todo-form', onsubmit: save },
        h('label', { class: 'sr-only', for: field.id }, 'Edit the to-do'),
        field,
        h('button', { type: 'submit', class: 'btn primary small' }, 'Save'),
        h('button', { type: 'button', class: 'btn ghost small', onclick: cancel }, 'Cancel'),
      ),
    );
  }
  return h(
    'li',
    { class: `todo${t.done ? ' done' : ''}`, 'data-m': `todo:${t.id}` },
    h('input', { type: 'checkbox', id: `todo-${t.id}`, checked: t.done, 'data-key': `todo-tick:${t.id}`, onchange: (/** @type {Event} */ e) => todoAction({ action: 'tick', id: t.id, done: /** @type {HTMLInputElement} */ (e.target).checked }, e) }),
    h('label', { class: 'todo-text', for: `todo-${t.id}` }, t.text),
    h(
      'div',
      { class: 'todo-actions' },
      t.planned ? h('span', { class: 'todo-planned', 'data-m': `planned:${t.id}` }, plannedAs(state, t.planned.to)) : t.done ? null : planTodoButton(state, t),
      h('button', { type: 'button', class: 'btn ghost small', 'data-key': `todo-edit-btn:${t.id}`, 'aria-label': `Edit: ${t.text}`, onclick: () => ((editingTodo = t.id), render(state)) }, 'Edit'),
      h('button', { type: 'button', class: 'btn ghost small', 'aria-label': `Delete: ${t.text}`, onclick: (/** @type {Event} */ e) => deleteTodo(t, index, e) }, 'Delete'),
    ),
  );
}

/**
 * The learner's to-do list: a field to add one, then the open to-dos and the done ones.
 * @param {any} s
 */
function todosPanel(s) {
  const todos = /** @type {any[]} */ (s.todos ?? []);
  const open = todos.filter((t) => !t.done);
  const field = /** @type {HTMLInputElement} */ (h('input', { type: 'text', id: 'todo-new', maxlength: 500, 'data-key': 'todo:new' }));
  field.value = drafts.get('todo:new') ?? '';
  field.addEventListener('input', () => drafts.set('todo:new', field.value));
  const add = (/** @type {Event} */ e) => {
    e.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    drafts.delete('todo:new');
    todoAction({ action: 'add', text }, e);
  };
  const rows = [...open, ...todos.filter((t) => t.done)].map(todoRow);
  if (undoTodo) rows.splice(Math.min(undoTodo.index, rows.length), 0, undoRow(undoTodo));
  return h(
    'section',
    { class: 'panel todos', 'aria-labelledby': 'todos-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'todos-title' }, 'Your list')),
    h('form', { class: 'todo-form', onsubmit: add }, h('label', { class: 'field-label', for: 'todo-new' }, 'New to-do'), field, h('button', { type: 'submit', class: 'btn secondary small' }, 'Add')),
    rows.length ? h('ul', { class: 'todo-list' }, ...rows) : h('p', { class: 'empty' }, 'Nothing here yet. Jot down an idea, a feature or a change, and send it to the plan when you are ready.'),
  );
}

/**
 * The to-dos on a page of their own, beside the plan they can join.
 * @param {any} s
 */
function todosView(s) {
  const todos = /** @type {any[]} */ (s.todos ?? []);
  const open = todos.filter((t) => !t.done).length;
  const head = h(
    'header',
    { class: 'head' },
    h(
      'div',
      { class: 'head-text' },
      h('h1', { id: 'title', tabindex: '-1' }, 'To-dos'),
      todos.length ? h('p', { class: 'status' }, h('span', { class: 'num' }, `${open} open · ${todos.length - open} done`)) : null,
      h('p', { class: 'why' }, 'Ideas, features and changes to come back to. They stay here between sessions.'),
    ),
  );
  return { nodes: [head, h('div', { class: 'todos-body' }, todosPanel(s), s.milestones?.length ? planPanel(s) : null)], bar: false };
}

/** @param {string} iso A short date, such as "Nov 6". */
function day(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** @param {string} url */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The finish line, once every task in the plan has passed: how it was built, in real figures, and
 * what was built, task by task. Adding a task brings the card back.
 * @param {any} s
 */
function finishView(s) {
  const f = s.finish;
  const w = s.written;
  const span = f.started && f.finished ? (day(f.started) === day(f.finished) ? `on ${day(f.finished)}` : `from ${day(f.started)} to ${day(f.finished)}`) : '';
  const head = h(
    'header',
    { class: 'head' },
    h(
      'div',
      { class: 'head-text' },
      h('h1', { id: 'title', tabindex: '-1' }, `${s.project ?? 'Your project'} is done`),
      h('p', { class: 'why' }, `Every task in your plan passed: ${plural(s.total, 'task')} in ${plural(s.milestones.length, 'milestone')}${span ? `, ${span}` : ''}.`),
    ),
  );
  const figure = (/** @type {string} */ label, /** @type {string} */ value, /** @type {string | null} */ unit, lead = false) =>
    h('div', { class: lead ? 'lead' : '' }, h('dt', null, label), h('dd', { class: 'num' }, value, unit ? h('span', { class: 'finish-unit' }, unit) : null));
  const field = h(
    'section',
    { class: 'finish', 'aria-labelledby': 'finish-title' },
    h('h2', { id: 'finish-title', class: 'sr-only' }, 'How you built it'),
    h(
      'dl',
      { class: 'finish-figures' },
      figure('Written by you', String(w.learner), ` of ${s.total}`, true),
      figure('Done by Menitor', String(w.delegated), w.skipped ? ` · ${w.skipped} skipped` : null),
      figure('Hints opened', String(f.hints), null),
    ),
    h(
      'div',
      { class: 'finish-foot' },
      h('p', null, `${f.explained}.`),
      f.deployUrl ? h('span', { class: 'finish-url' }, hostOf(f.deployUrl)) : h('span', { class: 'finish-url' }, 'Not deployed yet'),
      f.deployUrl ? h('a', { class: 'btn primary', href: f.deployUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open your live app') : null,
    ),
  );
  const built = h(
    'section',
    { class: 'panel built', 'aria-labelledby': 'built-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'built-title' }, 'What you built')),
    ...s.milestones.map((/** @type {any} */ m) =>
      h(
        'div',
        { class: 'built-milestone' },
        h('h3', null, m.title),
        h(
          'ol',
          { class: 'built-list' },
          ...m.tasks.map((/** @type {any} */ t) => h('li', null, h('button', { type: 'button', class: 'built-open', 'data-key': `built:${t.id}`, onclick: (/** @type {Event} */ e) => openFinished(t.id, e) }, t.goal), h('span', { class: 'built-by' }, t.by === 'learner' ? 'You' : t.skipped ? 'Menitor, skipped' : 'Menitor'))),
        ),
      ),
    ),
  );
  return { nodes: [head, field, h('div', { class: 'finish-body' }, built, planPanel(s, { full: true }))], bar: false };
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
  if (s.result && s.result.task !== prev?.result?.task) {
    const said = s.result.questions.at(-1)?.feedback ?? '';
    announce(`Task ${s.result.number} passed. ${said} Press Continue when you're ready for the next task.`);
    return;
  }
  if (prev && s.finish && !s.result && !prev.finish) {
    announce(`Every task is done. ${s.written.learner} of ${s.total} written by you.`);
    return;
  }
  const p = pressOf(s);
  const was = pressOf(prev);
  if (p && s.card && (p.at !== was?.at || p.state !== was?.state)) {
    if (p.state === 'working') {
      announce(PRESS_WORDS[p.type].doing);
      return;
    }
    if (p.state === 'done' && was && was.state !== 'done') {
      announce(pressLine(s).text);
      return;
    }
  }
  if (prev?.result && !s.result && s.card) {
    announce(`Now on task ${s.card.number} of ${s.card.total}: ${s.card.goal}`);
    return;
  }
  if (!prev?.card || !s.card) return;
  if (prev.card.task !== s.card.task) {
    announce(`Now on task ${s.card.number} of ${s.card.total}: ${s.card.goal}`);
    return;
  }
  const asked = openQuestion(s);
  if (asked && asked.id !== openQuestion(prev)?.id) {
    announce(`Menitor asks: ${asked.text}`);
    return;
  }
  const judged = (s.questions ?? []).find((/** @type {any} */ q) => q.outcome && !(prev.questions ?? []).some((/** @type {any} */ p) => p.id === q.id && p.outcome));
  if (judged) {
    announce(`${judged.outcome === 'good' ? 'Good answer.' : 'Not quite yet.'} ${judged.feedback ?? ''}`);
    return;
  }
  if (s.waiting && s.waiting.text !== prev.waiting?.text) {
    announce(`Menitor is waiting on you: ${s.waiting.text}`);
    return;
  }
  const next = (/** @type {any} */ x) => x.card.checklist.find((/** @type {any} */ i) => !i.ticked);
  if (s.typeAlong && next(s) && next(s)?.id !== next(prev)?.id) {
    announce(`Next step open: ${next(s).text}`);
    return;
  }
  if (s.lastCheck && s.lastCheck.at !== prev.lastCheck?.at) announce(findingOf(s).text);
  else if (s.card.hints.revealed > prev.card.hints.revealed) announce(`${RUNGS[s.card.hints.rungs[s.card.hints.revealed - 1]?.rung] ?? 'A'} hint is open`);
  else if (s.card.checklist.length > prev.card.checklist.length) announce(`${plural(s.card.checklist.length - prev.card.checklist.length, 'fix', 'fixes')} added to the steps`);
}

/**
 * Something on the main screen the learner should see while they're on another tab: Menitor's
 * feedback, a question, something Menitor waits on, or a press it has finished.
 * @param {any} s
 */
function mainNeedsYou(s) {
  if (!s?.ok) return false;
  if (s.result || s.waiting || s.skipRequested || openQuestion(s)) return true;
  const p = pressOf(s);
  return Boolean(p && p.type !== 'add' && p.state === 'done' && p.doneAt && Date.now() - Date.parse(p.doneAt) < DONE_SHOWN_MS);
}

/** The tab bar as last drawn, so a live update that changes nothing in it leaves it alone. */
let tabsKey = '';

/**
 * The tabs in the top bar: the main screen, named for what it shows, and the to-do list with how
 * many are open.
 * @param {any} s
 */
function renderTabs(s) {
  if (!s?.ok) {
    tabsNav.hidden = true;
    tabsKey = '';
    return;
  }
  const mainLabel = s.phase === 'task' ? 'Task' : s.phase === 'done' ? 'Summary' : 'Setup';
  const open = (s.todos ?? []).filter((/** @type {any} */ t) => !t.done).length;
  const dot = tab !== 'main' && mainNeedsYou(s);
  const key = [mainLabel, open, dot, tab].join('|');
  if (key === tabsKey && !tabsNav.hidden) return;
  tabsKey = key;
  /** @param {'main' | 'todos'} which @param {string} label @param {number} count @param {boolean} attention */
  const button = (which, label, count, attention) =>
    h(
      'button',
      { type: 'button', class: 'tab', 'data-key': `tab:${which}`, 'aria-current': tab === which ? 'page' : undefined, onclick: () => switchTab(which) },
      tab === which ? h('span', { class: 'tab-pill', 'aria-hidden': 'true' }) : null,
      // The words in one box over the pill, so the pill can glide beneath them.
      h(
        'span',
        { class: 'tab-text' },
        h('span', null, label),
        count ? h('span', { class: 'tab-count num' }, String(count), h('span', { class: 'sr-only' }, ' open')) : null,
        attention ? h('span', { class: 'tab-dot', 'aria-hidden': 'true' }) : null,
        attention ? h('span', { class: 'sr-only' }, ', needs you') : null,
      ),
    );
  tabsNav.replaceChildren(button('main', mainLabel, 0, dot), button('todos', 'To-dos', open, false));
  tabsNav.hidden = false;
}

/**
 * Go to the other tab. Each tab keeps its own scroll position, and leaving closes a finished task.
 * @param {'main' | 'todos'} next
 */
function switchTab(next) {
  if (tab === next && !finished) return;
  const win = content.ownerDocument.defaultView ?? window;
  scrollByTab[tab] = win.scrollY;
  withTransition(() => {
    tab = next;
    finished = null;
    syncHash();
    if (state) render(state);
    win.scrollTo(0, scrollByTab[next] ?? 0);
  });
}

/** @param {any} s */
function render(s) {
  const prev = state;
  state = s;
  markChanges(prev, s);
  // Keep the keyboard where it was: a tick re-renders the card.
  const doc = app.ownerDocument;
  const active = /** @type {HTMLElement | null} */ (doc.activeElement);
  const focusKey = active?.dataset?.key;
  const caret = active instanceof (doc.defaultView ?? window).HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;

  let view;
  if (!s.ok && s.stale) {
    view = problemView('This window is out of date', 'Menitor was updated after this window started, so it reads your plan with old rules. Ask your coding session to open the window again.');
  } else if (!s.ok) view = problemView("Menitor's state has a problem", `${s.error} Ask your coding session to validate Menitor's state and fix it.`);
  else if (finished) view = finishedView(s, finished.data);
  else if (tab === 'todos') view = todosView(s);
  else if (s.result) view = resultView(s);
  else if (s.phase === 'task' && s.card) view = taskView(s);
  else if (s.phase === 'done' && s.finish) view = finishView(s);
  else if ((s.phase === 'no-plan' || s.phase === 'draft') && s.setup) view = setupView(s);
  else view = messageView(s);

  const notice = s.ok && s.mentorMode === 'off' ? h('p', { class: 'notice', role: 'status' }, 'Mentor mode is off, so the agent may write code anywhere.') : null;
  content.replaceChildren(...(notice ? [notice] : []), ...view.nodes);
  applyMotion(content);
  sheet.classList.toggle('has-bar', view.bar);

  projectName.textContent = s.project ?? 'Your project';
  renderTabs(s);
  doc.title =
    finished && s.ok
      ? `Task ${finished.data.number} · ${finished.data.goal}`
      : tab === 'todos' && s.ok
        ? `To-dos · ${s.project ?? 'Menitor'}`
        : s.result
          ? `Passed · ${s.result.goal}`
          : s.card
            ? `${s.card.number}/${s.card.total} · ${s.card.goal}`
            : s.finish
              ? `${s.project ?? 'Your project'} is done`
              : 'Menitor';
  if (focusKey) {
    const again = /** @type {HTMLElement | null} */ (app.querySelector(`[data-key="${CSS.escape(focusKey)}"]`));
    again?.focus({ preventScroll: true });
    if (caret && again && 'setSelectionRange' in again) /** @type {HTMLTextAreaElement} */ (again).setSelectionRange(caret[0], caret[1]);
  }
  if (revealNext && s.typeAlong) {
    revealNext = false;
    const open = content.querySelector('.step.expanded');
    const still = doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches;
    open?.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }
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
    const next = JSON.parse(/** @type {MessageEvent} */ (e).data);
    if (state && viewKey(next) !== viewKey(state)) withTransition(() => render(next));
    else render(next);
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
    guardDocumentCopy(pip.document);
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

guardDocumentCopy(document);
setupPopout();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && finished && !e.defaultPrevented) closeFinished();
});
const finishedInLink = /^#task=([a-z][a-z0-9-]{0,31})$/.exec(location.hash)?.[1];
if (finishedInLink) openFinished(finishedInLink);
// A press's words change with time alone: "done" fades back to the usual line, and a press this
// page sent stops showing if the server never saw it. Re-render only when the line would change.
setInterval(() => {
  // The dot on the Task tab fades with the press it marks; the tabs redraw only if it changed.
  if (state?.ok) renderTabs(state);
  if (!state?.ok || !state.card || state.result) return;
  const shown = content.querySelector('.actions .how')?.textContent;
  if (shown !== undefined && shown !== pressLine(state).text) render(state);
}, 5000);

connect();
