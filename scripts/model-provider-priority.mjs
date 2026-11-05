/** @typedef {'openrouter' | 'deepseek'} ModelProvider */

/** @type {readonly ModelProvider[]} */
const DEFAULT_PRIORITY = ['openrouter', 'deepseek'];

/** Parse the complete allowlist in priority order; never silently ignore a typo. */
/** @param {string | undefined} value @returns {ModelProvider[]} */
export function parseModelProviderPriority(value) {
  const entries = (value ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) return [...DEFAULT_PRIORITY];
  /** @type {ModelProvider[]} */
  const providers = [];
  for (const entry of entries) {
    if (entry !== 'openrouter' && entry !== 'deepseek') {
      // Do not echo arbitrary environment contents into logs or HTTP responses.
      throw new Error('Invalid HUB_MODEL_PROVIDER_PRIORITY: use comma-separated openrouter and/or deepseek (case-insensitive).');
    }
    if (!providers.includes(entry)) providers.push(entry);
  }
  return providers;
}
