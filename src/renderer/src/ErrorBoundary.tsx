import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: string | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error: error.message }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI render error:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="content" style={{ padding: 24 }}>
          <h2>UI error</h2>
          <p style={{ color: 'var(--error)' }}>{this.state.error}</p>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
