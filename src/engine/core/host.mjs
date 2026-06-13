/**
 * HostContext — the integration interface between js-evolution-engine and
 * the host application that embeds it.
 *
 * Every field is optional. Pass only what you have; the engine degrades
 * gracefully when adapters are missing.
 *
 * @typedef {object} Logger
 * @property {(msg: string) => void} info
 * @property {(msg: string) => void} warning
 * @property {(msg: string) => void} error
 *
 * @typedef {object} Notifier
 * @property {(content: string, title?: string) => (void|Promise<void>)} sendMessage
 * @property {(content: string, opts?: object) => (void|Promise<void>)} sendErrorAlert
 *
 * @typedef {object} ActionVerifier
 * @property {(action: object, result: object, ctx: { projectRoot: string }) => object} verify
 *
 * @typedef {object} HostContext
 * @property {string} [basePath] Project root used for runtime data (default: process.cwd())
 * @property {string} [appName] Display name used in notification titles & log prefixes (default: "OADA")
 * @property {Logger} [logger]
 * @property {Notifier} [notifier]
 * @property {object} [intelligenceStore] Optional knowledge store (must implement append_jsonl/single_json/...)
 * @property {object} [knowledgeWriter] Optional knowledge writer
 * @property {object} [analyticsReader] Optional analytics provider, surfaced into AI observe context
 * @property {object} [client] Optional domain API client, exposed to action handlers
 * @property {Object<string, ActionVerifier>} [actionVerifiers] Action-type → verifier map (replaces hard-coded verifiers)
 * @property {Object<string, Function>} [actionHandlers] Action-type → handler(action, ctx) (used by ActionExecutor)
 */

/** @type {HostContext} */
export const NULL_HOST = Object.freeze({
  basePath: process.cwd(),
  appName: "OADA",
  logger: null,
  notifier: null,
  intelligenceStore: null,
  knowledgeWriter: null,
  analyticsReader: null,
  client: null,
  actionVerifiers: {},
  actionHandlers: {},
});

/**
 * Normalize a partial host into a full HostContext with defaults.
 * @param {Partial<HostContext>|null|undefined} host
 * @returns {HostContext}
 */
export function normalizeHost(host) {
  return {
    ...NULL_HOST,
    ...(host || {}),
    actionVerifiers: { ...(host?.actionVerifiers || {}) },
    actionHandlers: { ...(host?.actionHandlers || {}) },
  };
}
