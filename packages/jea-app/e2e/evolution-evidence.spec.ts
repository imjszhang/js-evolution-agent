import { expect, test } from '@playwright/test'
import { prepareVisualPage, visualScreenshotOptions } from './visual-ready'

async function shot(page: import('@playwright/test').Page, path: string, name: string, state?: string) {
  await prepareVisualPage(page, path)
  if (state) {
    await expect(page.getByTestId('evolution-inspector')).toHaveAttribute('data-state', state)
  }
  await expect(page).toHaveScreenshot(name, visualScreenshotOptions)
}

test('captures open, historical, verify-unavailable, malformed, collapsed, and expanded states', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })

  await shot(page, '/?locale=en', 'evolution-open.png', 'open')

  await prepareVisualPage(page, '/?locale=en')
  await page.getByTestId('evolution-open-cycle-fixture').click()
  await expect(page.getByTestId('evolution-inspector')).toHaveAttribute('data-state', 'historical')
  await expect(page).toHaveScreenshot('evolution-historical.png', visualScreenshotOptions)

  await shot(page, '/?locale=en&subject=beta', 'evolution-verify-unavailable.png', 'verify-unavailable')
  await shot(page, '/?locale=en&inspector=malformed', 'evolution-malformed.png', 'malformed')

  await prepareVisualPage(page, '/?locale=en')
  await page.getByTestId('inspector-toggle').click()
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-inspector-collapsed', 'true')
  await expect(page).toHaveScreenshot('evolution-collapsed.png', visualScreenshotOptions)
  await page.getByTestId('inspector-toggle').click()
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-inspector-collapsed', 'false')
  await expect(page).toHaveScreenshot('evolution-expanded.png', visualScreenshotOptions)
})
