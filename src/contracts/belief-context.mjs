function plainContext(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Return the canonical belief context for every action shape.
 *
 * Legacy/non-agent actions use params.context while agent actions normally use
 * params.run_spec.context. Merge both so partially migrated actions do not lose
 * causal identity; the run-spec context wins on duplicate keys.
 */
export function extractBeliefContext(action = {}) {
  const paramsContext = plainContext(action?.params?.context);
  const runSpec = action?.params?.run_spec
    ?? action?.params?.runSpec
    ?? action?.run_spec
    ?? action?.runSpec
    ?? {};
  const runSpecContext = plainContext(runSpec?.context);
  return {
    ...paramsContext,
    ...runSpecContext,
  };
}
