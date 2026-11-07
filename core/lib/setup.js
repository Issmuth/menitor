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
  { key: 'focus', label: 'Focus areas' },
  { key: 'help', label: 'Hints or type-along' },
  { key: 'stack-choice', label: 'Stack agreed' },
  { key: 'prd', label: 'PRD core draft' },
]);

/**
 * The interview that opens setup, asked in the window one question at a time. Choices are quick
 * picks; a learner can always answer in their own words instead.
 */
export const INTERVIEW = /** @type {const} */ ([
  { key: 'idea', question: 'What do you want to build?', help: 'A sentence or two is enough.', choices: [] },
  { key: 'goal', question: 'What is this project for?', help: 'Pick one, or say it your way.', choices: ['A portfolio piece', 'A job hunt', 'Learning a skill', 'Something real people will use'] },
  { key: 'time', question: 'How much time can you give it each week?', help: 'A rough guess is fine.', choices: ['Under 3 hours', '3 to 6 hours', '6 to 10 hours', 'More than 10 hours'] },
  { key: 'experience', question: 'What have you built before, and in which languages?', help: 'Projects, courses or exercises all count.', choices: [] },
  { key: 'stack', question: 'Is there a stack you want to use?', help: 'Name the tools, or let Menitor recommend one.', choices: ['Recommend one'] },
]);

/** The PRD core sections the learner drafts in the window, each saved under "prd-<key>". */
export const PRD_SECTIONS = /** @type {const} */ ([
  { key: 'problem', label: 'Problem', help: 'What goes wrong today, for whom, and why it matters.' },
  { key: 'users', label: 'Users', help: 'Who will use it. Be specific: a real person, if you can.' },
  { key: 'features', label: 'Must-have features', help: 'Three to five, one per line. Each small enough to build and test.' },
]);

/**
 * @typedef {typeof PRD_SECTIONS[number]['key']} PrdSection
 * @typedef {Partial<Record<PrdSection, { text: string, at: string }>>} Critique
 * @typedef {typeof SETUP_STEPS[number]['key']} SetupKey
 * @typedef {{ key: SetupKey, label: string, value: string, at: string, source: 'session' | 'window' }} SetupAnswer
 * @typedef {{ name: string, reasons: string[], hosting?: string }} StackOption
 * @typedef {{ stack?: StackOption[], focus?: string[], prd?: true }} SetupOptions
 * @typedef {{ answers: SetupAnswer[], missing: { key: SetupKey, label: string }[], options: SetupOptions, critique: Critique }} SetupStatus
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
