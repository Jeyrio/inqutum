'use client';

import React, { Component, ReactNode, ErrorInfo } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface BoundaryProps {
  children: ReactNode;
  fallbackMessage?: string;
  onRetry?: () => void;
  name?: string;
}

interface BoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class Boundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`Boundary caught an error in ${this.props.name || 'Component'}:`, error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onRetry) {
      this.props.onRetry();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="card text-center p-6 border-red-100 bg-red-50">
          <div className="flex justify-center mb-3">
            <AlertCircle className="w-10 h-10 text-red-500" />
          </div>
          <h3 className="text-lg font-semibold text-red-700 mb-2">
            {this.props.fallbackMessage || 'Something went wrong'}
          </h3>
          <p className="text-sm text-red-600 mb-4">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={this.handleRetry}
            className="btn btn-outline border-red-200 text-red-700 hover:bg-red-100 flex items-center justify-center gap-2 mx-auto"
          >
            <RefreshCw className="w-4 h-4" />
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
