/**
 * PromptBuilder — assembles structured prompts for OADA phases.
 *
 * Templates live in `./prompts/*.md` and use `{{PLACEHOLDER}}` tokens. Hosts
 * may override any template via `new PromptBuilder({ overrides: { decide: '...' } })`.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_REGISTRY } from '../decide/action-registry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, 'prompts');

/** @type {Record<string, string>} */
const TEMPLATE_FILES = {
  'analyze-decide': 'analyze-decide.md',
  'analyze': 'analyze.md',
  'decide': 'decide.md',
  'feature-design': 'feature-design.md',
  'feature-impl': 'feature-impl.md',
};

/** @param {string} key */
function loadTemplate(key) {
  const file = TEMPLATE_FILES[key];
  if (!file) throw new Error(`Unknown prompt template: ${key}`);
  return readFileSync(join(PROMPTS_DIR, file), 'utf-8');
}

/**
 * @param {string} template
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function render(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, v ?? '');
  }
  return out;
}

export class PromptBuilder {
  /**
   * @param {object} [opts]
   * @param {Record<string, string>} [opts.overrides] map template-key → template string
   * @param {ActionTypeRegistry} [opts.actionRegistry] override action registry (default: global ACTION_REGISTRY)
   */
  constructor({ overrides = {}, actionRegistry = null } = {}) {
    this._overrides = overrides;
    this._registry = actionRegistry || ACTION_REGISTRY;
  }

  /** @param {string} key */
  _template(key) {
    return this._overrides[key] || loadTemplate(key);
  }

  /**
   * Combined Analyze+Decide prompt (preferred — single AI call).
   * @param {object} rawData
   * @param {object} [opts]
   * @returns {string}
   */
  buildAnalysisDecisionPrompt(rawData, {
    constraints = null, humanGuidance = null, pendingIssues = null,
    goalsContext = null, intelligenceContext = null, observationReport = null,
    rules = null, agentContextDocs = null,
  } = {}) {
    const constraintsText = constraints && Object.keys(constraints).length
      ? JSON.stringify(constraints, null, 2) : 'No specific constraints';

    const guidanceSection = humanGuidance
      ? `\n### Operator guidance (advisory; use your judgement)\n${humanGuidance}\n` : '';

    const intelSection = intelligenceContext
      ? `\n### Historical intelligence (from knowledge base)\n${intelligenceContext}\n` : '';

    let issuesSection = '';
    if (pendingIssues && pendingIssues.length) {
      const lines = pendingIssues.map(iss => {
        const num = iss.number ?? '?';
        return `- #${num} ${iss.title || ''} (${iss.type || ''}, ${iss.priority || ''})`;
      });
      issuesSection = `
## Pending Tasks (existing Issues)
${lines.join('\n')}

Important:
- For actions essentially identical to an existing Issue: use \`"update_issue": <number>\` instead of duplicating
- For Issues you believe are misdirected: propose a replacing action and explain why in description
`;
    }

    const goalsSection = goalsContext ? `\n${goalsContext}\n` : '';
    const rulesSection = rules ? `\n${rules}\n` : '';

    let dataSection;
    if (observationReport) {
      dataSection = `## Observation Report (AI-driven)\n\n${observationReport}\n`;
    } else {
      dataSection = `## Observation Data

### Platform Performance
\`\`\`json
${JSON.stringify(rawData.platform || {}, null, 2)}
\`\`\`

### Execution Log Statistics
\`\`\`json
${JSON.stringify(rawData.execution || {}, null, 2)}
\`\`\`

### Content State
\`\`\`json
${JSON.stringify(rawData.content || {}, null, 2)}
\`\`\`

### Pending Feature Requests
\`\`\`json
${JSON.stringify(rawData.feature_requests || [], null, 2)}
\`\`\`
`;
    }

    return render(this._template('analyze-decide'), {
      AGENT_CONTEXT_DOCS: this._renderAgentContextDocs(agentContextDocs),
      GOALS_SECTION: goalsSection,
      RULES_SECTION: rulesSection,
      DATA_SECTION: dataSection,
      GUIDANCE_SECTION: guidanceSection,
      INTEL_SECTION: intelSection,
      ISSUES_SECTION: issuesSection,
      CONSTRAINTS_TEXT: constraintsText,
      ACTION_REGISTRY: this._registry.toPromptSection(),
    });
  }

  /**
   * @param {object} rawData
   * @param {object} [opts]
   * @returns {string}
   */
  buildAnalysisPrompt(rawData, {
    context = null, intelligenceContext = null, goalsContext = null,
    agentContextDocs = null,
  } = {}) {
    const contextSection = context
      ? `\n### Operator guidance (advisory)\n${context}` : '';
    const intelSection = intelligenceContext
      ? `\n### Historical intelligence (from knowledge base)\n${intelligenceContext}` : '';
    const goalsSection = goalsContext ? `\n${goalsContext}\n` : '';

    return render(this._template('analyze'), {
      AGENT_CONTEXT_DOCS: this._renderAgentContextDocs(agentContextDocs),
      GOALS_SECTION: goalsSection,
      PLATFORM_DATA: JSON.stringify(rawData.platform || {}, null, 2),
      EXECUTION_DATA: JSON.stringify(rawData.execution || {}, null, 2),
      CONTENT_DATA: JSON.stringify(rawData.content || {}, null, 2),
      FEATURE_REQUESTS: JSON.stringify(rawData.feature_requests || [], null, 2),
      CONTEXT_SECTION: contextSection,
      INTEL_SECTION: intelSection,
    });
  }

  /**
   * @param {object} analysisResult
   * @param {object} [opts]
   * @returns {string}
   */
  buildDecisionPrompt(analysisResult, {
    constraints = null, humanGuidance = null, pendingIssues = null, goalsContext = null,
    agentContextDocs = null,
  } = {}) {
    constraints = constraints || {};
    const constraintsText = Object.keys(constraints).length
      ? JSON.stringify(constraints, null, 2) : 'No specific constraints';

    const guidanceSection = humanGuidance ? `
## Operator Guidance (advisory; use your judgement)
${humanGuidance}
` : '';

    let issuesSection = '';
    if (pendingIssues && pendingIssues.length) {
      const lines = pendingIssues.map(iss => {
        const num = iss.number ?? '?';
        return `- #${num} ${iss.title || ''} (${iss.type || ''}, ${iss.priority || ''})`;
      });
      issuesSection = `
## Pending Tasks (existing Issues)
${lines.join('\n')}

Important rules:
- If your new action is essentially identical to an existing Issue, add \`"update_issue": <issue_number>\` to update rather than duplicate.
- If existing Issues already cover the action, don't propose duplicates.
`;
    }

    const goalsSection = goalsContext ? `\n${goalsContext}\n` : '';

    return render(this._template('decide'), {
      AGENT_CONTEXT_DOCS: this._renderAgentContextDocs(agentContextDocs),
      GOALS_SECTION: goalsSection,
      ANALYSIS_RESULT: JSON.stringify(analysisResult, null, 2),
      CONSTRAINTS_TEXT: constraintsText,
      GUIDANCE_SECTION: guidanceSection,
      ISSUES_SECTION: issuesSection,
      ACTION_REGISTRY: this._registry.toPromptSection(),
    });
  }

  /**
   * Render the agent-context documents section. Documents are injected
   * verbatim — the engine does not parse, trim, or transform their text.
   *
   * @param {Array<{id: string, source?: string, text: string}>|null|undefined} docs
   * @returns {string}
   */
  _renderAgentContextDocs(docs) {
    if (!docs || !Array.isArray(docs) || docs.length === 0) return '';
    const parts = [
      '## Agent Context Documents',
      '',
      '> The following documents are authoritative context. Follow them strictly.',
      '',
    ];
    docs.forEach((doc, idx) => {
      if (!doc || typeof doc.text !== 'string') return;
      const id = doc.id || `doc-${idx}`;
      const sourceLabel = doc.source ? `  (source: ${doc.source})` : '';
      parts.push(`### Document: ${id}${sourceLabel}`);
      parts.push('');
      parts.push(doc.text);
      parts.push('');
      parts.push('---');
      parts.push('');
    });
    return parts.join('\n');
  }

  /**
   * @param {object} featureRequest
   * @param {string} [codebaseContext]
   * @returns {string}
   */
  buildFeatureDesignPrompt(featureRequest, codebaseContext = null) {
    return render(this._template('feature-design'), {
      DESCRIPTION: featureRequest.description || 'unknown feature',
      PRIORITY: featureRequest.priority || 'medium',
      SOURCE: featureRequest.source || 'unknown',
      CODEBASE_CONTEXT: codebaseContext || '(see project README.md for structure)',
    });
  }

  /**
   * @param {object} designSpec
   * @param {string} featureDescription
   * @param {Record<string, string>} [existingCodeSnippets]
   * @returns {string}
   */
  buildFeatureImplementationPrompt(designSpec, featureDescription, existingCodeSnippets = null) {
    let filePlanText = '';
    for (const fp of (designSpec.file_plan || [])) {
      const actionLabel = fp.action === 'create' ? 'CREATE' : 'MODIFY';
      filePlanText += `- [${actionLabel}] \`${fp.path}\` - ${fp.description || ''}\n`;
    }

    let interfacesText = '';
    for (const iface of (designSpec.interfaces || [])) {
      interfacesText += `\n### ${iface.name || 'Unknown'}\n`;
      interfacesText += `- type: ${iface.type || 'class'}\n`;
      interfacesText += `- file: \`${iface.file || ''}\`\n`;
      interfacesText += `- responsibility: ${iface.description || ''}\n`;
      if (iface.signature) interfacesText += `- signature:\n\`\`\`javascript\n${iface.signature}\n\`\`\`\n`;
    }

    let integrationText = '';
    for (const ip of (designSpec.integration_points || [])) {
      integrationText += `- \`${ip.file}\`: ${ip.description || ''}\n`;
    }

    let codeContextText = '';
    if (existingCodeSnippets && Object.keys(existingCodeSnippets).length) {
      for (const [filepath, content] of Object.entries(existingCodeSnippets)) {
        codeContextText += `\n### \`${filepath}\`\n\`\`\`javascript\n${content}\n\`\`\`\n`;
      }
    } else {
      codeContextText = '(Sub-agent: read relevant files yourself)';
    }

    return render(this._template('feature-impl'), {
      FEATURE_DESCRIPTION: featureDescription,
      FILE_PLAN: filePlanText,
      INTERFACES: interfacesText,
      INTEGRATION: integrationText,
      IMPL_NOTES: designSpec.implementation_notes || 'none',
      CODE_CONTEXT: codeContextText,
    });
  }
}

/** Default singleton — convenient for places that don't need overrides. */
export const promptBuilder = new PromptBuilder();
