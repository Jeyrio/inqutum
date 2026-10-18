let freighterApi;
try {
  freighterApi = require('@stellar/freighter-api');
} catch {
  freighterApi = {};
}

/**
 * Custom Error Hierarchy for Freighter Adapter Operations
 */
class FreighterAdapterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FreighterAdapterError';
    this.code = code;
  }
}

class FreighterNotInstalledError extends FreighterAdapterError {
  constructor(message = 'Freighter wallet extension is not installed') {
    super(message, 'FREIGHTER_NOT_INSTALLED');
    this.name = 'FreighterNotInstalledError';
  }
}

class FreighterApiIncompatibleError extends FreighterAdapterError {
  constructor(message = 'Installed Freighter extension API is incompatible with this application') {
    super(message, 'FREIGHTER_API_INCOMPATIBLE');
    this.name = 'FreighterApiIncompatibleError';
  }
}

class FreighterUserDeclinedError extends FreighterAdapterError {
  constructor(message = 'Action was declined by the user in Freighter') {
    super(message, 'FREIGHTER_USER_DECLINED');
    this.name = 'FreighterUserDeclinedError';
  }
}

class FreighterLockedError extends FreighterAdapterError {
  constructor(message = 'Freighter wallet is locked. Please unlock the extension and try again.') {
    super(message, 'FREIGHTER_LOCKED');
    this.name = 'FreighterLockedError';
  }
}

class FreighterDisconnectedError extends FreighterAdapterError {
  constructor(message = 'Freighter wallet is disconnected or missing site permission.') {
    super(message, 'FREIGHTER_DISCONNECTED');
    this.name = 'FreighterDisconnectedError';
  }
}

const MIN_SUPPORTED_FREIGHTER_API_VERSION = '1.5.0';

function getFreighterApi() {
  if (typeof window !== 'undefined' && window.freighterApi) {
    return window.freighterApi;
  }
  return freighterApi || {};
}

/**
 * Helper to unwrap boolean or object response shapes from freighter-api.
 * Handles SDK shape changes across version boundaries seamlessly.
 */
function normalizeBooleanResponse(res, key) {
  if (typeof res === 'boolean') return res;
  if (res && typeof res === 'object' && typeof res[key] === 'boolean') {
    return res[key];
  }
  if (res && typeof res === 'object' && res.error) {
    throw res.error;
  }
  return Boolean(res);
}

/**
 * Feature detect API function availability
 */
function assertApiMethod(methodName, fn) {
  if (typeof fn !== 'function') {
    throw new FreighterApiIncompatibleError(
      `Freighter API method "${methodName}" is missing or invalid. Please update your Freighter extension.`
    );
  }
}

/**
 * Parse and classify errors thrown during raw Freighter calls into typed domain errors.
 */
function classifyFreighterError(error) {
  if (error instanceof FreighterAdapterError) {
    return error;
  }

  const msg = (typeof error === 'string' ? error : error?.message || String(error)).toLowerCase();

  if (msg.includes('user declined') || msg.includes('user denied') || msg.includes('declined') || msg.includes('rejected')) {
    return new FreighterUserDeclinedError();
  }

  if (msg.includes('locked') || msg.includes('unlock') || msg.includes('password')) {
    return new FreighterLockedError();
  }

  if (msg.includes('not allowed') || msg.includes('permission') || msg.includes('disconnected') || msg.includes('unauthorized')) {
    return new FreighterDisconnectedError();
  }

  if (msg.includes('not installed') || msg.includes('missing') || msg.includes('freighter is not defined')) {
    return new FreighterNotInstalledError();
  }

  return new FreighterAdapterError(error?.message || 'An error occurred interacting with Freighter', 'UNKNOWN_FREIGHTER_ERROR');
}

/**
 * Thin internal adapter for all Freighter extension API interactions.
 */
class FreighterAdapter {
  static instance;

  static getInstance() {
    if (!FreighterAdapter.instance) {
      FreighterAdapter.instance = new FreighterAdapter();
    }
    return FreighterAdapter.instance;
  }

  /**
   * Detect presence of Freighter extension within a configurable timeout.
   * Time Complexity: O(1)
   * Space Complexity: O(1)
   */
  async detectExtension(timeoutMs = 1000) {
    if (typeof window === 'undefined') return false;

    try {
      const api = getFreighterApi();
      assertApiMethod('isConnected', api.isConnected);

      const checkPromise = (async () => {
        const raw = await api.isConnected();
        return normalizeBooleanResponse(raw, 'isConnected');
      })();

      const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(false), timeoutMs);
      });

      return await Promise.race([checkPromise, timeoutPromise]);
    } catch (err) {
      return false;
    }
  }

  /**
   * Verify Freighter is installed; throws FreighterNotInstalledError if unavailable.
   */
  async assertInstalled(timeoutMs = 1000) {
    const installed = await this.detectExtension(timeoutMs);
    if (!installed) {
      throw new FreighterNotInstalledError();
    }
  }

  /**
   * Live pre-flight check of wallet connection and authorization.
   * Fails fast if wallet is disconnected, locked, or incompatible.
   */
  async checkConnectionAndAuthorization() {
    await this.assertInstalled();

    try {
      const api = getFreighterApi();
      const fn = api.isAllowed || api.requestAccess;
      assertApiMethod('isAllowed / requestAccess', fn);
      const isAllowedRaw = await fn();
      const isAllowed = normalizeBooleanResponse(isAllowedRaw, 'isAllowed');

      return { isConnected: true, isAllowed };
    } catch (error) {
      throw classifyFreighterError(error);
    }
  }

  /**
   * Request access permission from Freighter.
   */
  async requestAccess() {
    await this.assertInstalled();

    try {
      const api = getFreighterApi();
      const setFn = api.requestAccess || api.setAllowed;
      assertApiMethod('requestAccess / setAllowed', setFn);
      await setFn();

      const isAllowedFn = api.isAllowed || api.requestAccess;
      assertApiMethod('isAllowed / requestAccess', isAllowedFn);
      const allowedRaw = await isAllowedFn();
      return normalizeBooleanResponse(allowedRaw, 'isAllowed');
    } catch (error) {
      const classified = classifyFreighterError(error);
      if (classified instanceof FreighterUserDeclinedError) {
        return false;
      }
      throw classified;
    }
  }

  /**
   * Fetch current public key from Freighter wallet.
   */
  async getPublicKey() {
    await this.assertInstalled();

    try {
      const api = getFreighterApi();
      const getFn = api.getAddress || api.getPublicKey;
      assertApiMethod('getAddress / getPublicKey', getFn);
      const keyOrObj = await getFn();

      let key = '';
      if (typeof keyOrObj === 'string') {
        key = keyOrObj;
      } else if (keyOrObj && typeof keyOrObj === 'object') {
        if (keyOrObj.error) {
          throw new Error(keyOrObj.error);
        }
        key = keyOrObj.publicKey || keyOrObj.address || '';
      }

      if (!key) {
        throw new FreighterLockedError('Could not retrieve public key. Freighter may be locked or unauthorized.');
      }

      return key;
    } catch (error) {
      throw classifyFreighterError(error);
    }
  }

  /**
   * Sign an XDR transaction using Freighter.
   */
  async signTransaction(xdr, opts) {
    await this.assertInstalled();

    try {
      const api = getFreighterApi();
      assertApiMethod('signTransaction', api.signTransaction);
      const res = await api.signTransaction(xdr, opts);

      let signedXdr = '';
      if (typeof res === 'string') {
        signedXdr = res;
      } else if (res && typeof res === 'object') {
        if (res.error) {
          throw new Error(res.error);
        }
        signedXdr = res.signedTxXdr || res.signedXdr || res.xdr || '';
      }

      if (!signedXdr) {
        throw new FreighterAdapterError('Freighter returned empty signed transaction XDR', 'INVALID_SIGNATURE_RESPONSE');
      }

      return signedXdr;
    } catch (error) {
      throw classifyFreighterError(error);
    }
  }
}

const freighterAdapter = FreighterAdapter.getInstance();

module.exports = {
  FreighterAdapter,
  freighterAdapter,
  FreighterAdapterError,
  FreighterNotInstalledError,
  FreighterApiIncompatibleError,
  FreighterUserDeclinedError,
  FreighterLockedError,
  FreighterDisconnectedError,
  MIN_SUPPORTED_FREIGHTER_API_VERSION,
};
