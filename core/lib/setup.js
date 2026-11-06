// Setup answers (.menitor/setup.json): what the learner said during setup, in the order setup asks
// for it. Each answer is saved the moment it's given, so a new session resumes where the last one
// stopped instead of asking again.

/** Every setup answer, in the order setup asks. The keys match setup.schema.json. */
export const SETUP_STEPS = /** @type {const} */ ([
  { key: 'idea', label: 'Idea' },
  { key: 'goal', label: 'Goal' },
  { key: 'time', label: 'Time per week' },
  { key: 'experience', label: 'Experience' },
  { key: 'stack', label: 'Stack wanted' },
  { key: 'warmup-question', label: 'Warm-up question' },
  { key: 'warmup-answer', label: 'Warm-up answer' },
  { key: 'help', label: 'Hints or type-along' },
  { key: 'stack-choice', label: 'Stack agreed' },
  { key: 'prd', label: 'PRD core draft' },
]);

/**
 * @typedef {typeof SETUP_STEPS[number]['key']} SetupKey
 * @typedef {{ key: SetupKey, label: string, value: string, at: string }} SetupAnswer
 * @typedef {{ answers: SetupAnswer[], missing: { key: SetupKey, label: string }[] }} SetupStatus
 */

/** @param {string} key */
export function isSetupKey(key) {
  return SETUP_STEPS.some((s) => s.key === key);
}

/**
 * The saved answers, then what's still to ask, for people.
 * @param {SetupStatus} status
 */
export function renderSetup(status) {
  if (!status.answers.length) return `No setup answers saved yet. Still to ask: ${status.missing.map((m) => m.label).join(', ')}.`;
  const width = Math.max(...status.answers.map((a) => a.label.length));
  const lines = [`Setup answers (${status.answers.length} of ${SETUP_STEPS.length})`];
  for (const a of status.answers) {
    const [first, ...more] = a.value.split('\n');
    lines.push(`  ${a.label.padEnd(width)}  ${first}`);
    for (const line of more) lines.push(`  ${' '.repeat(width)}  ${line}`);
  }
  lines.push(status.missing.length ? `Still to ask: ${status.missing.map((m) => m.label).join(', ')}.` : 'Every setup answer is saved.');
  return lines.join('\n');
}
