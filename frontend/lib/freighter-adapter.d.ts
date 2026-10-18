export class FreighterAdapterError extends Error {
  readonly code: string;
  constructor(message?: string, code?: string);
}

export class FreighterNotInstalledError extends FreighterAdapterError {
  constructor(message?: string);
}

export class FreighterApiIncompatibleError extends FreighterAdapterError {
  constructor(message?: string);
}

export class FreighterUserDeclinedError extends FreighterAdapterError {
  constructor(message?: string);
}

export class FreighterLockedError extends FreighterAdapterError {
  constructor(message?: string);
}

export class FreighterDisconnectedError extends FreighterAdapterError {
  constructor(message?: string);
}

export const MIN_SUPPORTED_FREIGHTER_API_VERSION: string;

export class FreighterAdapter {
  static getInstance(): FreighterAdapter;
  detectExtension(timeoutMs?: number): Promise<boolean>;
  assertInstalled(timeoutMs?: number): Promise<void>;
  checkConnectionAndAuthorization(): Promise<{ isConnected: boolean; isAllowed: boolean }>;
  requestAccess(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, opts?: { networkPassphrase?: string; network?: string }): Promise<string>;
}

export const freighterAdapter: FreighterAdapter;
