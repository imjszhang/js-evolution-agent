import { describe, expect, it } from 'vitest';
import { main } from '../src/cli/jea.mjs';
import { PRODUCT_VERSION } from '../src/product/identity.mjs';

describe('jea --version', () => {
  it('prints the frozen product version without a token', async () => {
    const lines = [];
    const original = console.log;
    console.log = (value) => {
      lines.push(String(value));
    };
    try {
      const code = await main(['--version']);
      expect(code).toBe(0);
      expect(lines.join('\n').trim()).toBe(PRODUCT_VERSION);
      expect(lines.join('\n')).not.toMatch(/access_token|DEEPSEEK_API_KEY/);
    } finally {
      console.log = original;
    }
  });
});
