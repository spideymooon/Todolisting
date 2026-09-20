import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@renderer/shared/styles/tokens.css'
import '@renderer/shared/styles/widget.css'
import { WidgetApp } from './WidgetApp'

const container = document.getElementById('widget-root')
if (!container) throw new Error('#widget-root 不存在')

createRoot(container).render(
  <StrictMode>
    <WidgetApp />
  </StrictMode>
)
