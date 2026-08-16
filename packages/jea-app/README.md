# @jea/app

Shared, browser-safe JEA App Shell. Electron and a future localhost Web host
consume the same React source. This package must compile without Electron or
Node imports.

## Hosts

```ts
import { JeaApp } from '@jea/app'
import '@jea/app/styles.css'

export function DesktopOrWebRoot() {
  return <JeaApp />
}
```

`apps/desktop/src/renderer` mounts `JeaApp`. `packages/jea-app` also has a Vite
web entry (`src/web/main.tsx`) used for the dedicated renderer build and visual
baselines.

## Feature slots (Wave 2)

Do not edit `JeaApp` or `AppShell` to add Conversation, Evolution, or Setup UI.
Register a feature module:

```ts
import { registerFeature, type FeatureSlotProps } from '@jea/app'

function ConversationWorkspace(_props: FeatureSlotProps) {
  return <div>Channel conversation</div>
}

registerFeature({
  id: 'conversation',
  slots: { conversation: ConversationWorkspace }
})
```

Slot ids: `subjectList`, `conversation`, `evolutionInspector`, `serviceStatus`,
`settings`, `workspaceHeader`.

Wave 1 injects fixture adapters only. Do not invent a JeaClient here; #116 owns
the command catalog. Feature teams should accept an injected client through
their own slot props after that contract lands.

## Theme and i18n

- Theme preference is `system | light | dark`, stored in `localStorage` key
  `jea.theme`. Host HTML should run the no-flash boot script before paint.
- Shell copy is English / 简体中文 (`jea.locale`).

## Commands

```bash
npm run app:check   # typecheck + unit tests + web build + Playwright
npm run app:test
npm run app:build
```

The renderer ships Inter + a Noto Sans SC subset as `JeaUI` / `JeaCJK` and
does not use system UI fonts. Playwright waits for `document.fonts.ready`
before capturing. Comparisons allow `maxDiffPixelRatio: 0.02` because
Chromium antialiasing still differs slightly between this environment and
GitHub Actions ubuntu runners after fonts are pinned.

Linux screenshot baselines live in `e2e/baselines/visual.spec.ts-snapshots`.
This Cloud Agent cannot capture approved macOS Apple Silicon screenshots; the
harness is the update path for later certification. Update Linux baselines with:

```bash
npm run test:visual:update --workspace @jea/app
```

Approved macOS Apple Silicon screenshots are out of scope for this Linux agent.
The harness is the update path for later certification on macOS.
