import { text } from '../utils'

export interface PermissionOption {
  optionId: string
  kind: string
  name?: string
}

export interface PermissionRequest {
  requestId: string
  title: string
  toolKind: string
  inputSummary: string
  paths: string[]
  options: PermissionOption[]
  reason: string | null
}

function optionLabel(option: PermissionOption): string {
  if (option.name) return option.name
  return option.kind
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

export function PermissionCard({
  request,
  busy,
  onRespond
}: {
  request: PermissionRequest
  busy: boolean
  onRespond(optionId?: string): Promise<void>
}) {
  return (
    <article className="permission-card">
      <div className="permission-icon" aria-hidden="true">!</div>
      <div className="permission-content">
        <p className="section-kicker">Permission required</p>
        <h4>{request.title}</h4>
        <div className="permission-meta">
          <span>Tool: <strong>{text(request.toolKind, 'unknown')}</strong></span>
          {request.reason && <span>Advisory: <strong>{request.reason}</strong></span>}
        </div>
        {request.inputSummary && (
          <pre className="permission-input">{request.inputSummary}</pre>
        )}
        {request.paths.length > 0 && (
          <div className="path-list">
            {request.paths.map((path) => <code key={path}>{path}</code>)}
          </div>
        )}
        <div className="permission-actions">
          {request.options.map((option) => {
            const allowing = option.kind === 'allow_once' || option.kind === 'allow_always'
            return (
              <button
                type="button"
                key={option.optionId}
                className={`button ${allowing ? 'primary' : 'danger subtle'}`}
                disabled={busy}
                onClick={() => void onRespond(option.optionId)}
              >
                {optionLabel(option)}
              </button>
            )
          })}
          <button
            type="button"
            className="button ghost"
            disabled={busy}
            onClick={() => void onRespond()}
          >
            Cancel request
          </button>
        </div>
      </div>
    </article>
  )
}
