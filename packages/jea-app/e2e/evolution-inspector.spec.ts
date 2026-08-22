import { expect, test } from '@playwright/test'

test('keyboard reaches timeline, sections, and inspector toggle', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('jea.theme', 'light')
    localStorage.setItem('jea.locale', 'en')
  })
  await page.goto('/?locale=en&fixture=1')
  await page.locator('[data-testid="evolution-inspector"][data-ready="true"]').waitFor()
  const draft = page.getByTestId('conversation-draft')
  await draft.fill('keep-center-state')

  await page.getByTestId('evolution-cycle-cycle-20260816-open').focus()
  await expect(page.getByTestId('evolution-cycle-cycle-20260816-open')).toBeFocused()
  await page.keyboard.press('Tab')
  await page.getByTestId('evolution-section-report').focus()
  await expect(page.getByTestId('evolution-section-report')).toBeFocused()
  await page.getByTestId('evolution-open-cycle-fixture').click()
  await expect(page.getByTestId('evolution-inspector')).toHaveAttribute('data-state', 'historical')

  await page.getByTestId('inspector-toggle').click()
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-inspector-collapsed', 'true')
  await expect(draft).toHaveValue('keep-center-state')
  await page.getByTestId('inspector-toggle').click()
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-inspector-collapsed', 'false')
  await expect(page.getByTestId('evolution-inspector')).toBeVisible()
})
