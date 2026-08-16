import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { JeaApp } from '@jea/app'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <JeaApp />
  </StrictMode>
)
