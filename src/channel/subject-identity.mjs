import { extractMarkdownSection } from '../cli/commands/subject.mjs';
import { readSubjectPolicy } from '../cli/utils/subjects.mjs';

/**
 * Subject-facing identity for channel LLM prompts (role + persona voice).
 */
export function resolveSubjectReplyIdentity(root, subject) {
  const policy = readSubjectPolicy(root, subject);
  const subjectDescription = extractMarkdownSection(policy.text, 'Subject') || null;
  const persona = extractMarkdownSection(policy.text, 'Persona') || null;
  return {
    subject,
    subject_description: subjectDescription,
    persona,
  };
}
