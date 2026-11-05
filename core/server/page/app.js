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
    h('p', { class: `how${line.busy ? ' working' : ''}` }, line.text),
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
    q.feedback ? h('p', { class: 'feedback' }, q.feedback) : null,
  );
}

/** @param {any} s C-5, C-6: the explain-back questions, answered right here. */
function questionPanel(s) {
  const open = openQuestion(s);
  const past = (s.questions ?? []).filter((/** @type {any} */ q) => q.outcome !== null);
  /** @type {(Node | null)[]} */
  const main = [h('header', { class: 'panel-head' }, h('h2', { id: 'qa-title' }, 'Explain your code'), open ? h('span', { class: 'count' }, open.try === 1 ? 'One question' : 'One more question') : null)];
  if (open) {
    main.push(h('p', { class: 'question' }, open.text));
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
  if (s.waiting) nodes.push(callout('you', 'Menitor is waiting on you', s.waiting.text));
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
        { class: `item step${item.ticked ? ' done' : ''}${locked ? ' locked' : ''}${expanded ? ' expanded' : ''}` },
        h('div', { class: 'step-row' }, box, toggle),
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
  const counts = /** @type {Record<string, number>} */ ({ you: 0, menitor: 0, skipped: 0, now: 0, todo: 0, added: 0 });
  const rows = h('ol', { class: 'ledger' });
  for (const m of s.milestones) {
    const cells = h('ol', { class: 'cells' });
    for (const t of m.tasks ?? []) {
      const kind = t.current ? 'now' : !t.done ? 'todo' : t.skipped ? 'skipped' : t.by === 'learner' ? 'you' : 'menitor';
      counts[kind] += 1;
      if (t.added) counts.added += 1;
      const added = t.added ? ' (added later)' : '';
      cells.append(h('li', { class: `cell ${kind}${t.added ? ' added' : ''}`, title: `Task ${t.number}${added}: ${t.goal}` }, h('span', { class: 'sr-only' }, `Task ${t.number}${added}, ${t.goal}: ${KIND_WORDS[kind]}`)));
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
  key('added', 'Added later');
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
      h(
        'p',
        { class: 'status' },
        h('span', { class: 'num' }, `Task ${c.number} of ${c.total} · ${c.milestone.title}`),
        c.added ? h('span', { class: 'tag', title: `Added to the plan on ${new Date(c.added).toLocaleDateString()}` }, 'Added') : null,
        h('span', { class: `finding ${f.tone}` }, f.text),
      ),
      h('p', { class: 'why' }, c.why),
    ),
    learner ? actions(s) : null,
  );
  // DOM order is the phone's reading order: steps, hints, then the rail. Desktop places the rail beside the steps.
  const typeAlong = learner && s.typeAlong;
  // DOM order is the reading order on a phone: before you code, the steps, hints, then the plan.
  // On a desktop the grid puts before you code and the plan in the right-hand column.
  const board = h(
    'div',
    { class: `board${typeAlong ? ' typealong' : ''}` },
    learnPanel(c),
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
    render(await post('/api/continue', { task: r.task }));
  } catch (err) {
    btn.disabled = false;
    showToast(`Couldn't move on: ${/** @type {Error} */ (err).message}`, undefined, docOf(e));
  }
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
      h('h1', { id: 'title' }, r.goal),
      h('p', { class: 'status' }, h('span', { class: 'num' }, `Task ${r.number} of ${s.total}`), h('span', { class: 'finding good' }, 'Passed')),
    ),
  );
  const said = h(
    'section',
    { class: 'panel result', 'aria-labelledby': 'result-title' },
    h('header', { class: 'panel-head' }, h('h2', { id: 'result-title' }, 'Your explanation')),
    h(
      'ol',
      { class: 'result-list' },
      ...r.questions.map((/** @type {any} */ q) =>
        h(
          'li',
          { class: 'result-item' },
          h('p', { class: 'past-q' }, q.text),
          q.answer ? h('p', { class: 'past-a' }, q.answer.text) : h('p', { class: 'empty' }, 'Answered in your session.'),
          h('p', { class: `finding ${q.outcome === 'good' ? 'good' : ''}` }, q.outcome === 'good' ? 'Good answer' : 'Not quite yet'),
          q.feedback ? h('p', { class: 'result-feedback' }, q.feedback) : null,
        ),
      ),
    ),
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
      h('h1', { id: 'title' }, `${s.project ?? 'Your project'} is done`),
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
          ...m.tasks.map((/** @type {any} */ t) => h('li', null, h('span', null, t.goal), h('span', { class: 'built-by' }, t.by === 'learner' ? 'You' : t.skipped ? 'Menitor, skipped' : 'Menitor'))),
        ),
      ),
    ),
  );
  return { nodes: [head, field, h('div', { class: 'finish-body' }, built, planPanel(s))], bar: false };
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

/** @param {any} s */
function render(s) {
  const prev = state;
  state = s;
  // Keep the keyboard where it was: a tick re-renders the card.
  const doc = app.ownerDocument;
  const active = /** @type {HTMLElement | null} */ (doc.activeElement);
  const focusKey = active?.dataset?.key;
  const caret = active instanceof (doc.defaultView ?? window).HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;

  let view;
  if (!s.ok && s.stale) {
    view = problemView('This window is out of date', 'Menitor was updated after this window started, so it reads your plan with old rules. Ask your coding session to open the window again.');
  } else if (!s.ok) view = problemView("Menitor's state has a problem", `${s.error} Ask your coding session to validate Menitor's state and fix it.`);
  else if (s.result) view = resultView(s);
  else if (s.phase === 'task' && s.card) view = taskView(s);
  else if (s.phase === 'done' && s.finish) view = finishView(s);
  else view = messageView(s);

  const notice = s.ok && s.mentorMode === 'off' ? h('p', { class: 'notice', role: 'status' }, 'Mentor mode is off, so the agent may write code anywhere.') : null;
  content.replaceChildren(...(notice ? [notice] : []), ...view.nodes);
  sheet.classList.toggle('has-bar', view.bar);

  $('project').textContent = s.project ?? 'Your project';
  doc.title = s.result ? `Passed · ${s.result.goal}` : s.card ? `${s.card.number}/${s.card.total} · ${s.card.goal}` : s.finish ? `${s.project ?? 'Your project'} is done` : 'Menitor';
  if (focusKey) {
    const again = /** @type {HTMLElement | null} */ (content.querySelector(`[data-key="${CSS.escape(focusKey)}"]`));
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
// A press's words change with time alone: "done" fades back to the usual line, and a press this
// page sent stops showing if the server never saw it. Re-render only when the line would change.
setInterval(() => {
  if (!state?.ok || !state.card || state.result) return;
  const shown = content.querySelector('.actions .how')?.textContent;
  if (shown !== undefined && shown !== pressLine(state).text) render(state);
}, 5000);

connect();
