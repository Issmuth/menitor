// Errors the CLI prints for the agent and the learner to read.

export const EXIT = Object.freeze({
  ok: 0,
  /** Bad input, a missing file or invalid state. */
  error: 1,
  /** The action is not allowed: it needs the learner, or the plan is locked. */
  refused: 2,
});

export class MenitorError extends Error {
  /**
   * @param {string} message
   * @param {{ exit?: number, details?: string[] }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'MenitorError';
    this.exit = options.exit ?? EXIT.error;
    this.details = options.details ?? [];
  }
}

/**
 * An action the agent may not take on its own.
 * @param {string} message
 * @param {string[]} [details]
 */
export function refused(message, details) {
  return new MenitorError(message, { exit: EXIT.refused, details });
}
