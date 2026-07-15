import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { applyAppearanceToDocument, DEFAULT_APPEARANCE } from '../../shared/appearance'
import './styles.css'
import './styles/ui-overhaul.css'

const bootstrap =
  typeof window !== 'undefined' && window.api?.getInitialAppearance
    ? window.api.getInitialAppearance()
    : DEFAULT_APPEARANCE
applyAppearanceToDocument(document, bootstrap)
document.documentElement.classList.add('appearance-ready')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
