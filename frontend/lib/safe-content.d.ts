export const EXTERNAL_WINDOW_FEATURES: string;
export const PRINT_DOCUMENT_CSP: string;
export function escapeHtml(value: unknown): string;
export function csvCell(value: unknown): string;
export function safeExternalUrl(value: unknown): string | null;
export function explorerTransactionUrl(network: string, txHash: unknown): string;
export function explorerAccountUrl(network: string, publicKey: unknown): string;
export function buildMailtoUrl(address: unknown, subject: string, body: string): string | null;
