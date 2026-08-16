import { expect, test } from '@playwright/test'
import { prepareVisualPage, visualScreenshotOptions } from './visual-ready'

const states = [
  { name: 'workspace', path: '/?locale=en' },
  { name: 'settings', path: '/?locale=en&settings=1&cli=native' },
  { name: 'settings-cli-installed', path: '/?locale=en&settings=1&cli=installed' },
  { name: 'loading', path: '/?locale=en&state=loading' },
  { name: 'empty', path: '/?locale=en&state=empty' },
  { name: 'offline', path: '/?locale=en&state=offline' },
  { name: 'setup-fresh', path: '/?locale=en&setup=1' },
  { name: 'setup-channel', path: '/?locale=en&setup=channel' }
] as const

const viewports = [
  { name: 'electron-1440', width: 1440, height: 900 },
  { name: 'web-1280', width: 1280, height: 800 }
] as const

for (const viewport of viewports) {
  for (const state of states) {
    test(`${viewport.name} ${state.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await prepareVisualPage(page, state.path)
      if (state.name === 'workspace') {
        await expect(page.getByTestId('workspace')).toBeVisible()
      }
      if (state.name === 'settings' || state.name === 'settings-cli-installed') {
        await expect(page.getByTestId('settings-overlay')).toBeVisible()
        await expect(page.getByTestId('settings-panel')).toBeVisible()
      }
      if (state.name === 'setup-fresh') {
        await expect(page.getByTestId('setup-flow')).toBeVisible()
      }
      if (state.name === 'setup-channel') {
        await expect(page.getByTestId('setup-step-channel')).toBeVisible()
      }
      await expect(page).toHaveScreenshot(`${viewport.name}-${state.name}.png`, visualScreenshotOptions)
    })
  }
}
