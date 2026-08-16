import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JeaApp } from '../src/JeaApp'
import { createWave1Adapters } from '../src/fixtures/wave1'

describe('JEA App Shell', () => {
  it('renders the three-column workspace with placeholder slots', () => {
    const html = renderToStaticMarkup(<JeaApp locale="en" adapters={createWave1Adapters()} />)
    expect(html).toContain('data-testid="workspace"')
    expect(html).toContain('data-testid="column-subject"')
    expect(html).toContain('data-testid="column-conversation"')
    expect(html).toContain('data-testid="column-evolution"')
    expect(html).toContain('data-slot="subjectList"')
    expect(html).toContain('data-slot="conversation"')
    expect(html).toContain('data-slot="evolutionInspector"')
    expect(html).not.toContain('app-shell')
    expect(html).not.toContain('primary-nav')
    expect(html).not.toContain('Operations')
    expect(html).not.toContain('Todo Center')
  })

  it('keeps the conversation slot mounted while the inspector is collapsed in markup', () => {
    const html = renderToStaticMarkup(<JeaApp locale="en" />)
    expect(html).toContain('data-testid="conversation-draft"')
    expect(html).toContain('data-testid="inspector-toggle"')
  })

  it('renders global loading, empty, offline, and error states', () => {
    expect(renderToStaticMarkup(<JeaApp viewState="loading" locale="en" />)).toContain('data-testid="global-state-loading"')
    expect(renderToStaticMarkup(<JeaApp viewState="empty" locale="en" />)).toContain('data-testid="global-state-empty"')
    expect(renderToStaticMarkup(<JeaApp viewState="offline" locale="en" />)).toContain('data-testid="global-state-offline"')
    expect(renderToStaticMarkup(<JeaApp viewState="error" locale="en" />)).toContain('data-testid="global-state-error"')
  })
})
