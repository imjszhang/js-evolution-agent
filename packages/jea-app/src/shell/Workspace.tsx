import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useLocale } from '../i18n/LocaleProvider'
import { FeatureSlot } from '../slots/FeatureSlot'
import type { FeatureRegistry, ShellAdapters } from '../slots/types'
import { Button } from '../ui/button'
import { cn } from '../lib/cn'
import {
  HANDLE_WIDTH,
  LEFT_MAX,
  LEFT_MIN,
  RIGHT_MAX,
  RIGHT_MIN,
  defaultWorkspaceLayout,
  isCompactViewport,
  parseWorkspaceLayout,
  resizeLeft,
  resizeRight,
  setInspectorCollapsed,
  type WorkspaceLayout
} from './layout'
import {
  ConversationPlaceholder,
  EvolutionPlaceholder,
  SubjectListPlaceholder
} from './placeholders'

function readLayout(): WorkspaceLayout {
  if (typeof localStorage === 'undefined') return defaultWorkspaceLayout()
  try {
    return parseWorkspaceLayout(JSON.parse(localStorage.getItem('jea.workspace.layout') ?? 'null'))
      ?? defaultWorkspaceLayout()
  } catch {
    return defaultWorkspaceLayout()
  }
}

function persistLayout(layout: WorkspaceLayout): void {
  try {
    localStorage.setItem('jea.workspace.layout', JSON.stringify(layout))
  } catch {
    // Persistence is best-effort.
  }
}

export function Workspace({
  adapters,
  registry
}: {
  adapters: ShellAdapters
  registry?: FeatureRegistry
}) {
  const { t } = useLocale()
  const [layout, setLayout] = useState<WorkspaceLayout>(readLayout)
  const [compact, setCompact] = useState(false)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<null | { edge: 'left' | 'right'; startX: number; startWidth: number }>(null)

  useEffect(() => persistLayout(layout), [layout])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const sync = () => {
      const width = frameRef.current?.clientWidth ?? window.innerWidth
      setCompact(isCompactViewport(width))
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  const updateLayout = useCallback((next: WorkspaceLayout) => {
    setLayout(next)
  }, [])

  const onPointerDown = (edge: 'left' | 'right') => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      edge,
      startX: event.clientX,
      startWidth: edge === 'left' ? layout.leftWidth : layout.rightWidth
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const delta = event.clientX - drag.startX
    if (drag.edge === 'left') updateLayout(resizeLeft(layout, drag.startWidth + delta))
    else updateLayout(resizeRight(layout, drag.startWidth - delta))
  }

  const onPointerUp = () => {
    dragRef.current = null
  }

  const inspectorCollapsed = compact || layout.inspectorCollapsed
  const leftWidth = compact ? Math.min(layout.leftWidth, 240) : layout.leftWidth
  const rightWidth = inspectorCollapsed ? 0 : layout.rightWidth

  return (
    <div
      ref={frameRef}
      className="relative flex min-h-0 min-w-[320px] flex-1 overflow-hidden bg-background"
      data-testid="workspace"
      data-inspector-collapsed={inspectorCollapsed ? 'true' : 'false'}
    >
      <section
        aria-label={t('subjectList')}
        data-testid="column-subject"
        className="flex min-h-0 shrink-0 flex-col border-r border-border bg-surface"
        style={{ width: leftWidth }}
      >
        <FeatureSlot
          slotId="subjectList"
          adapters={adapters}
          registry={registry}
          fallback={<SubjectListPlaceholder slotId="subjectList" adapters={adapters} />}
        />
      </section>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resizeLeft')}
        aria-valuemin={LEFT_MIN}
        aria-valuemax={LEFT_MAX}
        aria-valuenow={leftWidth}
        tabIndex={0}
        data-testid="resize-left"
        className="flex w-2 cursor-col-resize items-stretch justify-center bg-transparent hover:bg-ring/30 focus-visible:bg-ring/40"
        style={{ width: HANDLE_WIDTH }}
        onPointerDown={onPointerDown('left')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') updateLayout(resizeLeft(layout, layout.leftWidth - 16))
          if (event.key === 'ArrowRight') updateLayout(resizeLeft(layout, layout.leftWidth + 16))
        }}
      />

      <section
        id="jea-conversation"
        aria-label={t('conversation')}
        data-testid="column-conversation"
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
      >
        <FeatureSlot
          slotId="conversation"
          adapters={adapters}
          registry={registry}
          fallback={<ConversationPlaceholder slotId="conversation" adapters={adapters} />}
        />
      </section>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('resizeRight')}
        aria-valuemin={RIGHT_MIN}
        aria-valuemax={RIGHT_MAX}
        aria-valuenow={layout.rightWidth}
        tabIndex={inspectorCollapsed ? -1 : 0}
        hidden={inspectorCollapsed}
        data-testid="resize-right"
        className={cn(
          'flex cursor-col-resize items-stretch justify-center hover:bg-ring/30 focus-visible:bg-ring/40',
          inspectorCollapsed && 'hidden'
        )}
        style={{ width: inspectorCollapsed ? 0 : HANDLE_WIDTH }}
        onPointerDown={onPointerDown('right')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') updateLayout(resizeRight(layout, layout.rightWidth + 16))
          if (event.key === 'ArrowRight') updateLayout(resizeRight(layout, layout.rightWidth - 16))
        }}
      />

      <section
        aria-label={t('evolutionInspector')}
        data-testid="column-evolution"
        hidden={inspectorCollapsed}
        className={cn(
          'flex min-h-0 shrink-0 flex-col border-l border-border bg-surface',
          inspectorCollapsed && 'hidden'
        )}
        style={{ width: rightWidth, overflow: 'hidden' }}
      >
        <FeatureSlot
          slotId="evolutionInspector"
          adapters={adapters}
          registry={registry}
          fallback={<EvolutionPlaceholder slotId="evolutionInspector" adapters={adapters} />}
        />
      </section>

      <Button
        variant="outline"
        size="icon"
        className="absolute top-3 right-3 z-20"
        data-testid="inspector-toggle"
        aria-pressed={!inspectorCollapsed}
        aria-label={inspectorCollapsed ? t('expandInspector') : t('collapseInspector')}
        onClick={() => updateLayout(setInspectorCollapsed(layout, !layout.inspectorCollapsed))}
      >
        {inspectorCollapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />}
      </Button>
    </div>
  )
}
