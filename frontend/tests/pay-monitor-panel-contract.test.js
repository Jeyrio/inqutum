const test = require('node:test');
const assert = require('node:assert/strict');

test('pay monitor panel contract - state display', () => {
  const getMonitorState = (active) => ({
    title: active ? 'Listening for payments' : 'Monitoring paused',
    description: active ? 'Watching for incoming payments' : 'Resume to monitor',
    icon: active ? 'bell' : 'bell-off',
  });

  const activeState = getMonitorState(true);
  assert.equal(activeState.title, 'Listening for payments');
  assert.equal(activeState.icon, 'bell');

  const pausedState = getMonitorState(false);
  assert.equal(pausedState.title, 'Monitoring paused');
  assert.equal(pausedState.icon, 'bell-off');
});

test('pay monitor panel contract - interval display', () => {
  const getIntervalText = (intervalMs) => {
    if (!intervalMs || intervalMs <= 0) return 'invalid interval';
    return `Checking every ${intervalMs / 1000} seconds`;
  };

  assert.equal(getIntervalText(1000), 'Checking every 1 seconds');
  assert.equal(getIntervalText(5000), 'Checking every 5 seconds');
  assert.equal(getIntervalText(30000), 'Checking every 30 seconds');
  assert.equal(getIntervalText(0), 'invalid interval');
});

test('pay monitor panel contract - state transition validation', () => {
  const validateStateTransition = (from, to) => {
    const validTransitions = {
      'paused': ['listening'],
      'listening': ['paused'],
    };
    return (validTransitions[from] || []).includes(to);
  };

  assert.ok(validateStateTransition('paused', 'listening'), 'can transition from paused to listening');
  assert.ok(validateStateTransition('listening', 'paused'), 'can transition from listening to paused');
  assert.ok(!validateStateTransition('paused', 'error'), 'cannot transition to invalid state');
  assert.ok(!validateStateTransition('listening', 'listening'), 'cannot transition to same state');
});

test('pay monitor panel contract - error state handling', () => {
  const getErrorDisplay = (error, isActive) => {
    if (error) {
      return {
        title: 'Monitoring error',
        description: error.message || 'Unknown error',
        icon: 'alert-triangle',
        showRetry: true,
      };
    }
    return {
      title: isActive ? 'Listening for payments' : 'Monitoring paused',
      description: isActive ? 'Watching for incoming payments' : 'Resume to monitor',
      icon: isActive ? 'bell' : 'bell-off',
      showRetry: false,
    };
  };

  const normalState = getErrorDisplay(null, true);
  assert.ok(!normalState.showRetry);
  assert.equal(normalState.icon, 'bell');

  const errorState = getErrorDisplay(new Error('Connection lost'), true);
  assert.ok(errorState.showRetry);
  assert.equal(errorState.icon, 'alert-triangle');
});

test('pay monitor panel contract - retry behavior', async () => {
  const handleRetry = async (previousError) => {
    if (!previousError) {
      throw new Error('No previous error to retry');
    }
    return { success: true, retried: true };
  };

  const error = new Error('Network timeout');
  // handleRetry is async: assert on the resolved value, not the pending Promise.
  const result = await handleRetry(error);
  assert.ok(result.success);
  assert.ok(result.retried);
});

test('pay monitor panel contract - accessibility', () => {
  const getAccessibilityAttrs = (active) => ({
    'aria-live': 'polite',
    'aria-label': active ? 'Payment monitor: listening' : 'Payment monitor: paused',
    'data-monitor-state': active ? 'listening' : 'paused',
  });

  const activeAttrs = getAccessibilityAttrs(true);
  assert.equal(activeAttrs['aria-live'], 'polite');
  assert.ok(activeAttrs['aria-label'].includes('listening'));
  assert.equal(activeAttrs['data-monitor-state'], 'listening');

  const pausedAttrs = getAccessibilityAttrs(false);
  assert.ok(pausedAttrs['aria-label'].includes('paused'));
  assert.equal(pausedAttrs['data-monitor-state'], 'paused');
});

test('pay monitor panel contract - animation state', () => {
  const getAnimationClass = (active) => {
    return active ? 'animate-spin text-cyan-600' : '';
  };

  assert.equal(getAnimationClass(true), 'animate-spin text-cyan-600');
  assert.equal(getAnimationClass(false), '');
});

test('pay monitor panel contract - degraded dependency', () => {
  const handleMonitorError = (error, fallbackMessage = 'Monitoring unavailable') => {
    const messages = {
      'connection-lost': 'Lost connection to payment monitor. Retrying...',
      'timeout': 'Payment monitor response timeout. Please refresh.',
      'unauthorized': 'Permission revoked for payment monitoring.',
      'unknown': fallbackMessage,
    };

    return messages[error?.code] || messages['unknown'];
  };

  assert.ok(handleMonitorError({ code: 'connection-lost' }).includes('Retrying'));
  assert.ok(handleMonitorError({ code: 'timeout' }).includes('refresh'));
  assert.ok(handleMonitorError({ code: 'unknown' }).includes('Monitoring unavailable'));
});
