/** @param {Record<string, string | undefined>} env
 * @returns {{maxAttempts: number, baseDelayMs: number, requestTimeoutMs: number, budgetMs: number}} */
export function modelRetryPolicy(env = process.env) {
  const integer = (name, fallback, minimum, maximum) => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${name}: expected an integer from ${minimum} to ${maximum}`);
    return parsed;
  };
  return {
    maxAttempts: integer('HUB_MODEL_MAX_ATTEMPTS', 2, 1, 5),
    baseDelayMs: integer('HUB_MODEL_RETRY_BASE_DELAY_MS', 1000, 0, 10000),
    requestTimeoutMs: integer('HUB_MODEL_REQUEST_TIMEOUT_MS', 25000, 100, 180000),
    budgetMs: integer('HUB_MODEL_RETRY_BUDGET_MS', 120000, 100, 240000),
  };
}
