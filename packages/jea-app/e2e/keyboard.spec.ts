import { expect, test } from '@playwright/test'

test('Cmd/Ctrl+, opens Settings, Esc closes it, and focus is restored', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem('jea.theme', 'light')
    localStorage.setItem('jea.locale', 'en')
  })
  await page.goto('/?locale=en&fixture=1')
  const trigger = page.getByTestId('open-settings')
  await trigger.focus()
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ',',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      bubbles: true,
      cancelable: true
    }))
  })
  await expect(page.getByTestId('settings-overlay')).toBeVisible()
  await expect(page.locator('[data-testid="workspace"]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-overlay')).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('inspector collapse keeps the conversation draft mounted', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?locale=en&fixture=1')
  const draft = page.getByTestId('conversation-draft')
  await draft.fill('keep-center-state')
  await page.getByTestId('inspector-toggle').click()
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-inspector-collapsed', 'true')
  await expect(draft).toHaveValue('keep-center-state')
  await page.getByTestId('inspector-toggle').click()
  await expect(page.getByTestId('workspace')).toHaveAttribute('data-inspector-collapsed', 'false')
  await expect(draft).toHaveValue('keep-center-state')
})
