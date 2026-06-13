/**
 * OADA Action Type Registry — single source of truth for action types.
 *
 * All action-type metadata (name, description, label, risk level, prompt hint)
 * is centralised here. Consumers (engine/exec/verify/prompt/github) read from
 * this registry. Adding a new action type requires only one registration.
 *
 * The registry ships with a small set of generic builtins. Host applications
 * are expected to register their own domain-specific action types via
 * `ACTION_REGISTRY.register(new ActionTypeSpec({...}))` at startup.
 */

/** @typedef {{ name: string, description: string, promptHint: string, defaultRisk?: string, defaultPriority?: string, autoExecutable?: boolean, labelColor?: string, labelName?: string, layer?: string }} ActionTypeSpecInit */

class ActionTypeSpec {
  /**
   * @param {ActionTypeSpecInit} init
   */
  constructor({
    name, description, promptHint,
    defaultRisk = 'high', defaultPriority = 'medium',
    autoExecutable = true, labelColor = 'c5def5', labelName,
    layer = null,
  }) {
    this.name = name;
    this.description = description;
    this.promptHint = promptHint;
    this.defaultRisk = defaultRisk;
    this.defaultPriority = defaultPriority;
    this.autoExecutable = autoExecutable;
    this.labelColor = labelColor;
    this.labelName = labelName ?? null;
    // Free-form metadata; the engine does not validate or interpret it.
    // Hosts may use it to express domain-specific classifications such as
    // "core / buffer / probe" tiers.
    this.layer = layer || null;
  }

  getLabelName() {
    return this.labelName ?? `type/${this.name.replace(/_/g, '-')}`;
  }

  toPromptLine() {
    const suffix = this.layer ? `  [layer: ${this.layer}]` : '';
    return `- \`${this.name}\`: ${this.promptHint}${suffix}`;
  }

  toLabelDef() {
    return { name: this.getLabelName(), color: this.labelColor, description: this.description };
  }
}

/**
 * Generic, domain-agnostic builtin action types. Hosts may register more.
 * @type {Record<string, ActionTypeSpec>}
 */
const BUILTIN_ACTION_TYPES = {
  implement_feature: new ActionTypeSpec({
    name: 'implement_feature',
    description: 'Implement a new feature',
    promptHint: 'Implement a new feature (provide feature_request_id and a design summary; spawns a sub-agent to write code)',
    defaultRisk: 'high',
    autoExecutable: false,
  }),
  fix_reliability: new ActionTypeSpec({
    name: 'fix_reliability',
    description: 'Fix a reliability issue',
    promptHint: 'Fix a reliability problem (describe the symptom and root-cause hypothesis)',
    defaultRisk: 'high',
  }),
  refactor_code: new ActionTypeSpec({
    name: 'refactor_code',
    description: 'Refactor existing code',
    promptHint: 'Refactor existing code (describe the target module and intent)',
    defaultRisk: 'medium',
  }),
  update_config: new ActionTypeSpec({
    name: 'update_config',
    description: 'Update configuration',
    promptHint: 'Update a configuration file (specify the file path and the desired change)',
    defaultRisk: 'medium',
  }),
  generate_content: new ActionTypeSpec({
    name: 'generate_content',
    description: 'Generate content artifacts',
    promptHint: 'Generate new content artifacts (specify topic, style, count)',
    defaultRisk: 'low',
  }),
};

export class ActionTypeRegistry {
  /** @param {{ includeBuiltins?: boolean }} [opts] */
  constructor({ includeBuiltins = true } = {}) {
    /** @type {Map<string, ActionTypeSpec>} */
    this._specs = new Map();
    if (includeBuiltins) {
      for (const [k, v] of Object.entries(BUILTIN_ACTION_TYPES)) {
        this._specs.set(k, v);
      }
    }
  }

  /** @param {ActionTypeSpec} spec */
  register(spec) {
    const validRisks = new Set(['low', 'medium', 'high']);
    if (!validRisks.has(spec.defaultRisk)) {
      throw new Error(`Invalid defaultRisk '${spec.defaultRisk}', allowed: ${[...validRisks]}`);
    }
    this._specs.set(spec.name, spec);
  }

  /** @param {string} name */
  get(name) { return this._specs.get(name) ?? null; }

  listAll() { return [...this._specs.values()]; }

  validNames() { return new Set(this._specs.keys()); }

  toPromptSection() {
    return [...this._specs.values()].map(s => s.toPromptLine()).join('\n');
  }

  toLabelDefs() {
    return [...this._specs.values()].map(s => s.toLabelDef());
  }

  toLabelMapping() {
    /** @type {Record<string, string>} */
    const m = {};
    for (const [name, spec] of this._specs) m[name] = spec.getLabelName();
    return m;
  }

  toReverseLabelMapping() {
    /** @type {Record<string, string>} */
    const m = {};
    for (const [name, spec] of this._specs) m[spec.getLabelName()] = name;
    return m;
  }

  autoExecutableNames() {
    const s = new Set();
    for (const [name, spec] of this._specs) { if (spec.autoExecutable) s.add(name); }
    return s;
  }

  skippedNames() {
    const s = new Set();
    for (const [name, spec] of this._specs) { if (!spec.autoExecutable) s.add(name); }
    return s;
  }

  getRiskMapping() {
    /** @type {Record<string, string>} */
    const m = {};
    for (const [name, spec] of this._specs) m[name] = spec.defaultRisk;
    return m;
  }

  get size() { return this._specs.size; }
  has(name) { return this._specs.has(name); }
}

export const ACTION_REGISTRY = new ActionTypeRegistry();
export { ActionTypeSpec };
