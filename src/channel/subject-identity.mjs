import { extractMarkdownSection } from '../infra/markdown-sections.mjs';
import { readSubjectPolicy, readSubjectSoul } from '../infra/subjects.mjs';

/**
 * Subject-facing identity for channel LLM prompts (governance + persona voice).
 * Governance description comes from SUBJECT.md; persona/soul from SOUL.md (not authority docs).
 */
export function resolveSubjectReplyIdentity(root, subject) {
  const policy = readSubjectPolicy(root, subject);
  const soul = readSubjectSoul(root, subject);
  const subjectDescription = extractMarkdownSection(policy.text, 'Subject') || null;
  const soulText = soul.text?.trim() ? soul.text : null;
  const legacyPersona = soul.source === 'legacy_persona_section' ? soulText : null;
  const persona = soulText;

  return {
    subject,
    subject_description: subjectDescription,
    persona,
    soul: soulText,
    soul_source: soul.source,
    legacy_persona: legacyPersona,
  };
}
