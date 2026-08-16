import { JeaProductApp } from '@jea/app'
import { createDesktopRendererClient } from './jea-desktop-client'

const desktopClient = createDesktopRendererClient()

export default function App() {
  return <JeaProductApp client={desktopClient} host="electron" />
}
