import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

export const HOST_META_TAG = '<meta name="jea-host" content="1" />'

export function resolveAppAssetDir(sourceRoot: string, override?: string): string | null {
  const candidate = override ?? join(sourceRoot, 'packages/jea-app/dist')
  return existsSync(join(candidate, 'index.html')) ? candidate : null
}

export function injectHostMeta(html: string): string {
  if (html.includes('name="jea-host"')) return html
  if (html.includes('<head>')) return html.replace('<head>', `<head>\n    ${HOST_META_TAG}`)
  return `${HOST_META_TAG}\n${html}`
}

export function fallbackHostHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    ${HOST_META_TAG}
    <title>JEA</title>
  </head>
  <body>
    <div id="root" data-testid="web-host-fallback">JEA Web host</div>
  </body>
</html>`
}

export function readHostAsset(assetDir: string | null, urlPath: string): { body: Buffer; type: string } | null {
  if (!assetDir) {
    if (urlPath === '/' || urlPath === '/index.html') {
      return { body: Buffer.from(fallbackHostHtml()), type: MIME['.html'] }
    }
    return null
  }

  const raw = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const relativePath = raw === '/' ? 'index.html' : raw.replace(/^\/+/, '')
  const resolved = resolve(assetDir, relativePath)
  const rel = relative(resolve(assetDir), resolved)
  if (rel.startsWith('..') || rel.startsWith(sep) || normalize(rel).includes(`..${sep}`)) return null
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    if (!extname(relativePath)) {
      const index = join(assetDir, 'index.html')
      if (existsSync(index)) {
        return { body: Buffer.from(injectHostMeta(readFileSync(index, 'utf8'))), type: MIME['.html'] }
      }
    }
    return null
  }
  const body = readFileSync(resolved)
  const type = MIME[extname(resolved).toLowerCase()] ?? 'application/octet-stream'
  if (type.startsWith('text/html')) {
    return { body: Buffer.from(injectHostMeta(body.toString('utf8'))), type }
  }
  return { body, type }
}
