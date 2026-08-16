import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test('shell and Settings overlay have no critical accessibility violations', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => {
    localStorage.setItem('jea.theme', 'light')
    localStorage.setItem('jea.locale', 'en')
  })
  await page.goto('/?locale=en')
  const workspace = await new AxeBuilder({ page }).analyze()
  expect(workspace.violations.filter((item) => item.impact === 'critical'), JSON.stringify(workspace.violations, null, 2)).toEqual([])

  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-overlay')).toBeVisible()
  const settings = await new AxeBuilder({ page }).analyze()
  expect(settings.violations.filter((item) => item.impact === 'critical'), JSON.stringify(settings.violations, null, 2)).toEqual([])
})
