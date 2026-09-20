import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@renderer/shared/styles/tokens.css'
import '@renderer/shared/styles/app.css'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
