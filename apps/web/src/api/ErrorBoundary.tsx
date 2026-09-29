import React from 'react';

type Props = { name: string; children: React.ReactNode; reloadOnRetry?: boolean };
type State = { failed: boolean };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="alert" role="alert">
      <strong>{this.props.name} could not be displayed.</strong>
      <p>Other loaded sections remain available.</p>
      <button type="button" onClick={() => this.props.reloadOnRetry ? window.location.reload() : this.setState({ failed: false })}>
        {this.props.reloadOnRetry ? 'Reload application' : 'Retry section'}
      </button>
    </section>;
  }
}
