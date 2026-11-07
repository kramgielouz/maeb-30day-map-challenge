import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

// Stops one broken chapter from blanking the whole site.
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Chapter crashed:', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <p className="eyebrow">Something went wrong</p>
        <h2>This chapter hit an error</h2>
        <p className="muted">{this.state.error.message}</p>
        <p>
          <a href="/">Back to the calendar</a>
        </p>
      </div>
    );
  }
}
