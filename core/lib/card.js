// The task card: one task at a time, the same shape in the terminal and in the window.

import { findTask } from './plan.js';
import { RUNGS } from './learner.js';

/**
 * @typedef {import('./plan.js').Plan} Plan
 * @typedef {import('./state.js').Progress} Progress
 * @typedef {object} CardData
 * @property {string} task
 * @property {number} number
 * @property {number} total
 * @property {{ id: string, title: string, number: number }} milestone
 * @property {string} goal
 * @property {string} why
 * @property {{ label: string, url: string | null } | null} learn
 * @property {string} docs
 * @property {'learner' | 'delegated'} owner
 * @property {boolean} skipped
 * @property {'todo' | 'done'} status
 * @property {string | null} branch
 * @property {{ id: string, text: string, source: 'plan' | 'fix', ticked: boolean }[]} checklist
 * @property {string[]} doneWhen
 * @property {{ stored: boolean, revealed: number, rungs: { rung: string, open: boolean, text: string | null }[] }} hints
 * @property {string | null} note
 */

/**
 * Everything the window or the agent needs to show a card. Locked hint text is never included.
 * @param {Plan} plan
 * @param {string} taskId
 * @param {Progress} progress
 * @returns {CardData}
 */
export function cardData(plan, taskId, progress) {
  const { task, milestone, index, total, milestoneIndex } = findTask(plan, taskId);
  return {
    task: task.id,
    number: index + 1,
    total,
    milestone: { id: milestone.id, title: milestone.title, number: milestoneIndex + 1 },
    goal: task.goal,
    why: task.why,
    learn: task.learn ? { label: task.learn.label, url: task.learn.url ?? null } : null,
    docs: task.docs,
    owner: task.owner,
    skipped: task.skipped ?? false,
    status: task.status,
    branch: task.branch ?? milestone.branch ?? null,
    checklist: task.checklist.map((item) => ({ ...item, ticked: Boolean(progress.ticks[item.id]) })),
    doneWhen: task.doneWhen,
    hints: {
      stored: task.hints !== null,
      revealed: task.hintsRevealed,
      rungs: RUNGS.map((rung, i) => ({
        rung,
        open: i < task.hintsRevealed,
        text: i < task.hintsRevealed && task.hints ? task.hints[i].text : null,
      })),
    },
    note: task.note ?? null,
  };
}

const LABEL_WIDTH = 11;

/**
 * @param {string} label
 * @param {string} text
 */
function row(label, text) {
  return `${label.padEnd(LABEL_WIDTH)}${text}`;
}

/**
 * Render a card as plain text, in the shape the PRD shows.
 * @param {CardData} card
 * @param {{ ids?: boolean }} [options]  ids: show checklist IDs (for the agent)
 */
export function renderCard(card, options = {}) {
  const lines = [`Task ${card.number}/${card.total} · Milestone ${card.milestone.number}: ${card.milestone.title}${card.status === 'done' ? ' · done' : ''}`];
  lines.push(row('Goal', card.goal));
  lines.push(row('Why', card.why));
  if (card.learn) lines.push(row('Learn', card.learn.url ? `${card.learn.label} (${card.learn.url})` : card.learn.label));
  lines.push(row('Docs', card.docs));
  if (card.owner === 'delegated') lines.push(row('Owner', card.skipped ? 'Menitor (skipped by the learner)' : 'Menitor (delegated)'));
  for (const item of card.checklist) {
    const box = item.ticked ? '[x]' : '[ ]';
    const id = options.ids ? `${item.id} ` : '';
    const fix = item.source === 'fix' ? 'Fix: ' : '';
    lines.push(`${box} ${id}${fix}${item.text}`);
  }
  card.doneWhen.forEach((d, i) => lines.push(row(i === 0 ? 'Done when' : '', d)));
  lines.push(row('Hints', hintSummary(card)));
  for (const r of card.hints.rungs) {
    if (r.open && r.text) lines.push(row('', `${r.rung}: ${r.text.split('\n')[0]}${r.text.includes('\n') ? ' …' : ''}`));
  }
  if (card.note) lines.push(row('Note', card.note));
  return lines.join('\n');
}

/**
 * @param {CardData} card
 */
function hintSummary(card) {
  const names = RUNGS.join(' · ');
  const { revealed, stored } = card.hints;
  if (!stored) return `${names} (not written yet)`;
  if (revealed === 0) return `${names} (all locked)`;
  if (revealed === RUNGS.length) return `${names} (all open)`;
  return `${names} (${revealed} open, ${RUNGS.length - revealed} locked)`;
}
