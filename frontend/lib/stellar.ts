import * as StellarSdk from '@stellar/stellar-sdk';
import * as FreighterApi from '@stellar/freighter-api';
import {
  isConnected,
  getPublicKey,
  signTransaction,
  isAllowed,
  setAllowed,
  getNetwork,
  getNetworkDetails,
} from '@stellar/freighter-api';
import { detectFreighter } from './freighter-availability';
import { explorerTransactionUrl } from './safe-content.js';

// Network configuration
export const STELLAR_NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'TESTNET';
export const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ||
  (STELLAR_NETWORK === 'TESTNET'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org');

export const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === 'TESTNET'
    ? StellarSdk.Networks.TESTNET
    : StellarSdk.Networks.PUBLIC;

export const NETWORK_DISPLAY_NAME = networkDisplayName(NETWORK_PASSPHRASE);
export const EXPECTED_WALLET_NETWORK = STELLAR_NETWORK.toUpperCase();

export const server = new StellarSdk.Horizon.Server(HORIZON_URL);

// Malformed hashes fall back to the explorer home rather than building a link from untrusted text.
export const getExplorerTransactionUrl = (txHash: string): string =>
  explorerTransactionUrl(STELLAR_NETWORK, txHash);

export const getExplorerAccountUrl = (publicKey: string, walletNetwork = STELLAR_NETWORK): string => {
  const network = walletNetwork === 'PUBLIC' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/account/${encodeURIComponent(publicKey)}`;
};

const getTrustlineMessage = (assetCode: string): string =>
  `Your wallet does not have a ${assetCode} trustline on ${STELLAR_NETWORK.toLowerCase()}. Add the ${assetCode} trustline in Freighter, or ask the seller for an XLM invoice.`;

const hasAssetTrustline = (
  account: StellarSdk.Horizon.AccountResponse,
  assetCode: string,
  assetIssuer: string
): boolean =>
  account.balances.some(
    (balance: any) =>
      balance.asset_type !== 'native' &&
      balance.asset_code === assetCode &&
      balance.asset_issuer === assetIssuer
  );

const isMissingTrustlineError = (error: any): boolean => {
  const operationCodes = error?.response?.data?.extras?.result_codes?.operations;
  return (
    operationCodes?.includes('op_no_trust') ||
    error?.message?.toLowerCase().includes('op_no_trust') ||
    error?.message?.toLowerCase().includes('no trustline')
  );
};

export const describeStellarNetworkError = (error: any): string => {
  if (error?.message?.includes('Not Found') || error?.response?.status === 404) {
    return 'Account needs funding on the selected Stellar network.';
  }
  if (!error?.response || ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)) {
    return 'Stellar Horizon is temporarily unreachable. Your wallet can stay connected; retry shortly.';
  }
  return error?.message || 'Stellar network request failed.';
};

import { freighterAdapter } from './freighter-adapter';

/**
 * Check whether the Freighter extension API is available
 */
export const checkWalletConnection = async (): Promise<boolean> => {
  return await freighterAdapter.detectExtension();
};

/**
 * Request permission to access wallet
 */
export const requestWalletAccess = async (): Promise<boolean> => {
  return await freighterAdapter.requestAccess();
};

/**
 * Get user's public key from wallet
 */
export const getUserPublicKey = async (): Promise<string | null> => {
  try {
    return await freighterAdapter.getPublicKey();
  } catch (error) {
    console.error('Error getting public key:', error);
    return null;
  }
};

export const readFreighterSession = async (): Promise<FreighterSession> => {
  const freighterAvailable = await checkWalletConnection();
  if (!freighterAvailable) {
    return {
      freighterAvailable: false,
      connected: false,
      publicKey: null,
      network: null,
      networkPassphrase: null,
    };
  }

  const [allowed, publicKey, network] = await Promise.all([
    isAllowed().then((value) => readResultBoolean(value, 'isAllowed')).catch(() => false),
    getUserPublicKey(),
    getFreighterNetwork(),
  ]);

  return {
    freighterAvailable: true,
    connected: allowed && Boolean(publicKey),
    publicKey,
    network: network?.network ?? null,
    networkPassphrase: network?.networkPassphrase ?? null,
  };
};

export const stopFreighterWalletWatcher = (
  onChange: (session: FreighterSession) => void,
  intervalMs = 1000
): (() => void) => {
  const WatchWalletChanges = (FreighterApi as any).WatchWalletChanges;
  if (typeof WatchWalletChanges !== 'function') return () => {};

  const watcher = new WatchWalletChanges(intervalMs);
  watcher.watch((change: any) => {
    onChange({
      freighterAvailable: true,
      connected: Boolean(change?.address || change?.publicKey),
      publicKey: change?.address || change?.publicKey || null,
      network: change?.network || null,
      networkPassphrase: change?.networkPassphrase || null,
    });
  });

  return () => watcher.stop();
};

export const assertFreighterReady = async (): Promise<FreighterSession> => {
  const session = await readFreighterSession();
  if (!session.freighterAvailable) throw new Error(FREIGHTER_REQUIRED_MESSAGE);
  if (!session.connected || !session.publicKey) throw new Error(FREIGHTER_CONNECT_REQUIRED_MESSAGE);
  if (!networkMatches(session.network, EXPECTED_WALLET_NETWORK)) {
    throw new Error(wrongNetworkMessage(EXPECTED_WALLET_NETWORK, session.network));
  }
  return session;
};

/**
 * Query current network and passphrase from Freighter
 */
export const getFreighterNetwork = async (): Promise<FreighterNetwork | null> => {
  try {
    const connected = await checkWalletConnection();
    if (!connected) return null;

    const [netResult, detailsResult] = await Promise.allSettled([
      getNetwork(),
      getNetworkDetails(),
    ]);

    const networkName = netResult.status === 'fulfilled' ? netResult.value : null;
    const details = detailsResult.status === 'fulfilled' ? detailsResult.value : null;

    const rawNetwork = networkName || details?.network || null;
    let passphrase = details?.networkPassphrase || null;

    if (!passphrase && rawNetwork) {
      const upper = rawNetwork.toUpperCase();
      if (upper === 'PUBLIC' || upper === 'MAINNET') {
        passphrase = StellarSdk.Networks.PUBLIC;
      } else if (upper === 'TESTNET') {
        passphrase = StellarSdk.Networks.TESTNET;
      }
    }

    if (!rawNetwork && !passphrase) return null;

    return {
      network: rawNetwork || (passphrase === StellarSdk.Networks.PUBLIC ? 'PUBLIC' : 'TESTNET'),
      networkPassphrase: passphrase || (rawNetwork?.toUpperCase() === 'PUBLIC' ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET),
      networkUrl: details?.networkUrl,
    };
  } catch (error) {
    console.error('Error getting Freighter network:', error);
    return null;
  }
};

/**
 * Check if the given network or passphrase matches our expected network
 */
export const isWrongNetwork = (
  currentNetworkOrPassphrase: string | null | undefined,
  expectedNetwork: string = STELLAR_NETWORK
): boolean => {
  if (!currentNetworkOrPassphrase) return false;
  const current = currentNetworkOrPassphrase.trim();
  const expected = expectedNetwork.toUpperCase();
  const expectedPassphrase =
    expected === 'TESTNET' ? StellarSdk.Networks.TESTNET : StellarSdk.Networks.PUBLIC;

  if (
    current.toUpperCase() === expected ||
    current === expectedPassphrase
  ) {
    return false;
  }

  // Check if current is matching known counterpart
  if (expected === 'TESTNET' && current.toLowerCase().includes('test sdf network')) {
    return false;
  }
  if (expected === 'PUBLIC' && current.toLowerCase().includes('public global stellar network')) {
    return false;
  }

  return true;
};

/**
 * Watch Freighter network changes on an interval
 */
export const watchFreighterNetwork = (
  callback: (details: { network: string; networkPassphrase: string; isWrongNetwork: boolean } | null) => void,
  intervalMs = 2500
): (() => void) => {
  let active = true;

  const poll = async () => {
    if (!active) return;
    try {
      const details = await getFreighterNetwork();
      if (!active) return;
      if (details?.network && details.networkPassphrase) {
        const wrong = isWrongNetwork(details.networkPassphrase || details.network);
        callback({
          network: details.network,
          networkPassphrase: details.networkPassphrase,
          isWrongNetwork: wrong,
        });
      } else {
        callback(null);
      }
    } catch {
      if (active) callback(null);
    }
  };

  void poll();
  const intervalId = setInterval(poll, intervalMs);

  return () => {
    active = false;
    clearInterval(intervalId);
  };
};

/**
 * Load account from Stellar network
 */
export const loadAccount = async (
  publicKey: string
): Promise<StellarSdk.Horizon.AccountResponse> => {
  return await server.loadAccount(publicKey);
};

/**
 * Get account balance
 */
export const getAccountBalance = async (
  publicKey: string
): Promise<Array<{ assetCode: string; balance: string }>> => {
  try {
    const account = await loadAccount(publicKey);
    return account.balances.map((balance: any) => ({
      assetCode: balance.asset_type === 'native' ? 'XLM' : balance.asset_code,
      balance: balance.balance,
    }));
  } catch (error: any) {
    console.error('Error getting balance:', error);
    // If account not found, return empty balance
    if (error.message?.includes('Not Found') || error.response?.status === 404) {
      return [{ assetCode: 'XLM', balance: '0.0000000' }];
    }
    throw error;
  }
};

/**
 * Verify Freighter extension is configured on the expected network before building transactions.
 */
export const checkFreighterNetwork = async (expectedNetwork: string = STELLAR_NETWORK): Promise<void> => {
  try {
    const res = await getNetwork();
    const walletNetwork = typeof res === 'string' ? res : (res as any)?.network;
    const walletPassphrase = (res as any)?.networkPassphrase;

    if (walletNetwork && walletNetwork.toUpperCase() !== expectedNetwork.toUpperCase()) {
      throw new Error(
        `Freighter wallet network (${walletNetwork.toUpperCase()}) does not match required invoice network (${expectedNetwork.toUpperCase()}). Please switch your wallet to ${expectedNetwork.toUpperCase()} to continue.`
      );
    }

    if (walletPassphrase && walletPassphrase !== NETWORK_PASSPHRASE) {
      throw new Error(
        `Freighter wallet network passphrase does not match required invoice network passphrase. Please switch your wallet to ${expectedNetwork.toUpperCase()} to continue.`
      );
    }
  } catch (error: any) {
    if (error.message?.includes('does not match')) {
      throw error;
    }
    // Fallback to getNetworkDetails if getNetwork throws an error or is formatted differently
    try {
      const details: any = await getNetworkDetails();
      const passphrase = details?.networkPassphrase;
      const netName = details?.network;

      if (netName && netName.toUpperCase() !== expectedNetwork.toUpperCase()) {
        throw new Error(
          `Freighter wallet network (${netName.toUpperCase()}) does not match required invoice network (${expectedNetwork.toUpperCase()}). Please switch your wallet to ${expectedNetwork.toUpperCase()} to continue.`
        );
      }

      if (passphrase && passphrase !== NETWORK_PASSPHRASE) {
        throw new Error(
          `Freighter wallet network passphrase does not match required network passphrase. Please switch your wallet to ${expectedNetwork.toUpperCase()} to continue.`
        );
      }
    } catch (innerError: any) {
      if (innerError.message?.includes('does not match')) {
        throw innerError;
      }
    }
  }
};

/**
 * Send payment with memo
 */
export const sendPayment = async (
  destination: string,
  amount: string,
  memo: string,
  assetCode: string = 'XLM',
  assetIssuer?: string,
  isSessionCurrent?: (sourceAccount: string) => boolean
): Promise<string> => {
  try {
    // Live pre-flight check of connection & authorization (Issue #21)
    await freighterAdapter.checkConnectionAndAuthorization();

    // Pre-flight Freighter network mismatch check
    await checkFreighterNetwork(STELLAR_NETWORK);

    // Get user public key
    const userPublicKey = await getUserPublicKey();
    if (!userPublicKey) {
      throw new Error('Could not get user public key');
    }

    // Load account
    let account;
    try {
      account = await loadAccount(userPublicKey);
    } catch (error: any) {
      if (error.message?.includes('Not Found') || error.response?.status === 404) {
        throw new Error('Account not funded. Please get test XLM from Stellar Laboratory first.');
      }
      throw error;
    }

    const normalizedAssetCode = (assetCode || 'XLM').toUpperCase();

    // Create asset
    const asset =
      normalizedAssetCode === 'XLM'
        ? StellarSdk.Asset.native()
        : new StellarSdk.Asset(normalizedAssetCode, assetIssuer!);

    if (
      normalizedAssetCode !== 'XLM' &&
      assetIssuer &&
      !hasAssetTrustline(account, normalizedAssetCode, assetIssuer)
    ) {
      throw new Error(getTrustlineMessage(normalizedAssetCode));
    }

    // Build transaction
    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination,
          asset,
          amount,
        })
      )
      .addMemo(StellarSdk.Memo.text(memo))
      .setTimeout(180)
      .build();

    // Sign with Freighter via compatibility adapter (Issue #24)
    const signedTxXdr = await freighterAdapter.signTransaction(transaction.toXDR(), {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    const signedTxXdr = readResultString(signedResult, ['signedTxXdr']);
    if (!signedTxXdr) {
      throw new Error('Freighter did not return a signed transaction');
    }

    // Parse signed transaction
    const signedTx = StellarSdk.TransactionBuilder.fromXDR(
      signedTxXdr,
      NETWORK_PASSPHRASE
    );

    // Do not broadcast a transaction if Freighter changed accounts while its
    // signing prompt was open. The source account is fixed in the signed XDR,
    // but the user must confirm the new wallet session before any payment.
    if (isSessionCurrent && !isSessionCurrent(userPublicKey)) {
      throw new Error('Freighter account changed during payment');
    }

    // Submit to network
    const result = await server.submitTransaction(signedTx as any);

    console.log('Payment successful:', result.hash);
    return result.hash;
  } catch (error: any) {
    console.error('Payment error:', error);
    if (assetCode !== 'XLM' && isMissingTrustlineError(error)) {
      throw new Error(getTrustlineMessage(assetCode));
    }
    throw new Error(error.message || 'Payment failed');
  }
};

/**
 * Get transaction details
 */
export const getTransaction = async (txHash: string): Promise<any> => {
  try {
    const transaction = await server.transactions().transaction(txHash).call();
    return transaction;
  } catch (error) {
    console.error('Error fetching transaction:', error);
    throw error;
  }
};

/**
 * Check transaction status
 */
export const checkTransactionStatus = async (
  txHash: string
): Promise<'success' | 'failed' | 'pending'> => {
  try {
    const tx = await getTransaction(txHash);
    return tx.successful ? 'success' : 'failed';
  } catch (error) {
    return 'pending';
  }
};

/**
 * Stream payments for an account
 */
export const streamPayments = (
  publicKey: string,
  onPayment: (payment: any) => void
) => {
  const closeHandler = server
    .payments()
    .forAccount(publicKey)
    .cursor('now')
    .stream({
      onmessage: (payment: any) => {
        if (payment.type === 'payment') {
          onPayment(payment);
        }
      },
      onerror: (error: any) => {
        console.error('Payment stream error:', error);
      },
    });

  return closeHandler;
};

/**
 * Format Stellar amount (remove trailing zeros)
 */
export const formatStellarAmount = (amount: string | number): string => {
  return parseFloat(amount.toString()).toString();
};

/**
 * Validate Stellar public key
 */
export const isValidPublicKey = (publicKey: string): boolean => {
  try {
    StellarSdk.Keypair.fromPublicKey(publicKey);
    return true;
  } catch {
    return false;
  }
};

const stellarService = {
  server,
  STELLAR_NETWORK,
  HORIZON_URL,
  NETWORK_PASSPHRASE,
  NETWORK_DISPLAY_NAME,
  checkWalletConnection,
  requestWalletAccess,
  getUserPublicKey,
  getFreighterNetwork,
  isWrongNetwork,
  watchFreighterNetwork,
  loadAccount,
  getAccountBalance,
  sendPayment,
  getTransaction,
  checkTransactionStatus,
  streamPayments,
  formatStellarAmount,
  isValidPublicKey,
  describeStellarNetworkError,
};

export default stellarService;
