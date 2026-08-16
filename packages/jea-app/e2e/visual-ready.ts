import type { Page } from '@playwright/test'

export async function prepareVisualPage(page: Page, path: string): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    localStorage.setItem('jea.theme', 'light')
    localStorage.setItem('jea.locale', 'en')
  })
  await page.goto(path)
  await page.locator('#root').waitFor({ state: 'visible' })
  await page.evaluate(async () => {
    await document.fonts.ready
    const loaded = await Promise.all([
      document.fonts.load('400 16px JeaUI'),
      document.fonts.load('600 16px JeaUI'),
      document.fonts.load('400 16px JeaCJK')
    ])
    if (loaded.some((faces) => faces.length === 0) || !document.fonts.check('16px JeaUI')) {
      throw new Error('bundled JeaUI/JeaCJK fonts did not load')
    }
  })
  const inspector = page.locator('[data-testid="evolution-inspector"]')
  if (await inspector.count()) {
    await page.locator('[data-testid="evolution-inspector"][data-ready="true"]').waitFor({
      state: 'attached',
      timeout: 10_000
    })
  }
}

export const visualScreenshotOptions = {
  animations: 'disabled' as const,
  caret: 'hide' as const,
  // Same bundled fonts still produce ~1% LCD/AA noise between this VM and
  // GitHub Actions ubuntu runners. 2% is a documented cross-runner allowance,
  // not a license to skip visual coverage.
  maxDiffPixelRatio: 0.02
}
