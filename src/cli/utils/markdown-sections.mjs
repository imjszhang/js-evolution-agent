/**
 * Extract body of a `## Heading` section from Markdown (until next `## ` or EOF).
 */
export function extractMarkdownSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
  return text.match(re)?.[1]?.trim() || '';
}
