/**
 * Production Invoice Email Templates with contextual escaping (Issue #36).
 *
 * All variables are substituted via EmailTemplateEngine with automatic context-specific
 * escaping. No string interpolation or concatenation into raw markup is permitted.
 */

import { EmailTemplateDefinition, EmailTemplateEngine } from './email-template-engine';

export const INVOICE_PAYMENT_REQUEST_DEFINITION: EmailTemplateDefinition = {
  subject: 'Invoice #{{header:invoiceIdShort}} from {{header:sellerName}} ({{amount}} {{assetCode}})',
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invoice #{{html:invoiceIdShort}}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background-color: #f8fafc; color: #1e293b; line-height: 1.5; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .header { background: #0f172a; color: #ffffff; padding: 28px 32px; text-align: left; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
    .header .subtitle { margin-top: 6px; font-size: 14px; color: #94a3b8; }
    .content { padding: 32px; }
    .amount-card { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px; }
    .amount-label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #166534; letter-spacing: 0.5px; }
    .amount-value { font-size: 32px; font-weight: 800; color: #15803d; margin: 4px 0; }
    .amount-asset { font-size: 16px; font-weight: 600; color: #166534; }
    .info-group { margin-bottom: 20px; }
    .info-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; margin-bottom: 4px; letter-spacing: 0.5px; }
    .info-value { font-size: 14px; color: #0f172a; font-weight: 500; word-break: break-all; }
    .info-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .btn-container { text-align: center; margin: 32px 0 24px; }
    .btn { display: inline-block; background: #0ea5e9; color: #ffffff !important; font-size: 15px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px; transition: background 0.2s; }
    .memo-highlight { font-family: monospace; font-size: 15px; font-weight: 700; color: #0f172a; background: #e2e8f0; padding: 4px 8px; border-radius: 4px; display: inline-block; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 32px; text-align: center; font-size: 12px; color: #64748b; }
    .footer a { color: #0ea5e9; text-decoration: none; }
    .notice { font-size: 12px; color: #64748b; margin-top: 16px; border-left: 3px solid #0ea5e9; padding-left: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Quittance Payment Request</h1>
      <div class="subtitle">Invoice #{{html:invoiceIdShort}} from {{html:sellerName}}</div>
    </div>
    <div class="content">
      <div class="amount-card">
        <div class="amount-label">Amount Due</div>
        <div class="amount-value">{{html:amount}}</div>
        <div class="amount-asset">{{html:assetCode}}</div>
      </div>

      {{#if customerName}}
      <div class="info-group">
        <div class="info-label">Billed To</div>
        <div class="info-value">{{html:customerName}}</div>
      </div>
      {{/if}}

      {{#if description}}
      <div class="info-group">
        <div class="info-label">Description / Notes</div>
        <div class="info-value" style="white-space: pre-wrap;">{{html:description}}</div>
      </div>
      {{/if}}

      <div class="info-box">
        <div class="info-group">
          <div class="info-label">Required Payment Memo (Stellar)</div>
          <div class="info-value"><span class="memo-highlight">{{html:memo}}</span></div>
        </div>
        <div class="info-group">
          <div class="info-label">Seller Stellar Address</div>
          <div class="info-value">{{html:sellerPublicKey}}</div>
        </div>
        <div class="info-group" style="margin-bottom: 0;">
          <div class="info-label">Expires At</div>
          <div class="info-value">{{html:formattedExpiresAt}}</div>
        </div>
      </div>

      <div class="btn-container">
        <a href="{{url:paymentUrl}}" class="btn" target="_blank" rel="noopener noreferrer">Review &amp; Pay Invoice</a>
      </div>

      <div class="notice">
        <strong>Payment Instructions:</strong> Pay securely via Freighter wallet or send payment to the Stellar address with the exact memo above for automated on-chain verification.
      </div>
    </div>
    <div class="footer">
      Powered by <a href="{{url:frontendOrigin}}" target="_blank" rel="noopener noreferrer">Quittance</a> — Stellar Invoice &amp; Payment Proof Platform
    </div>
  </div>
</body>
</html>`,
  text: `QUITTANCE PAYMENT REQUEST
Invoice #{{text:invoiceIdShort}} from {{text:sellerName}}

AMOUNT DUE: {{text:amount}} {{text:assetCode}}
{{#if customerName}}
BILLED TO: {{text:customerName}}
{{/if}}
{{#if description}}
DESCRIPTION / NOTES:
{{text:description}}
{{/if}}

PAYMENT DETAILS:
- Memo (Required): {{text:memo}}
- Seller Address: {{text:sellerPublicKey}}
- Expires: {{text:formattedExpiresAt}}

PAY ONLINE:
{{text:paymentUrl}}

Settlement is verified directly on the Stellar blockchain.
Powered by Quittance`,
};

export const PAYMENT_PROOF_RECEIPT_DEFINITION: EmailTemplateDefinition = {
  subject: 'Payment Proof: Invoice #{{header:invoiceIdShort}} ({{amount}} {{assetCode}})',
  html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Proof #{{html:invoiceIdShort}}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; background-color: #f8fafc; color: #1e293b; line-height: 1.5; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
    .header { background: #065f46; color: #ffffff; padding: 28px 32px; text-align: left; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
    .header .subtitle { margin-top: 6px; font-size: 14px; color: #a7f3d0; }
    .badge { display: inline-block; background: #d1fae5; color: #065f46; font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; margin-top: 10px; }
    .content { padding: 32px; }
    .amount-card { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px; }
    .amount-label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #166534; letter-spacing: 0.5px; }
    .amount-value { font-size: 32px; font-weight: 800; color: #15803d; margin: 4px 0; }
    .amount-asset { font-size: 16px; font-weight: 600; color: #166534; }
    .info-group { margin-bottom: 16px; }
    .info-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; margin-bottom: 4px; letter-spacing: 0.5px; }
    .info-value { font-size: 13px; color: #0f172a; font-weight: 500; word-break: break-all; font-family: -apple-system, BlinkMacSystemFont, monospace; }
    .info-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 32px; text-align: center; font-size: 12px; color: #64748b; }
    .footer a { color: #065f46; text-decoration: none; }
    .proof-confirmed { background: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 8px; padding: 12px 16px; font-size: 13px; color: #065f46; margin-bottom: 20px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Payment Proof / Quittance</h1>
      <div class="subtitle">Invoice #{{html:invoiceIdShort}} — Settlement Verified on Stellar</div>
      <span class="badge">Verified Paid</span>
    </div>
    <div class="content">
      <div class="proof-confirmed">
        ✓ <strong>On-Chain Payment Verified:</strong> This invoice has settled on the Stellar blockchain.
      </div>

      <div class="amount-card">
        <div class="amount-label">Amount Settled</div>
        <div class="amount-value">{{html:amount}}</div>
        <div class="amount-asset">{{html:assetCode}}</div>
      </div>

      <div class="info-box">
        <div class="info-group">
          <div class="info-label">Invoice ID</div>
          <div class="info-value">{{html:invoiceId}}</div>
        </div>
        <div class="info-group">
          <div class="info-label">Settlement Date</div>
          <div class="info-value">{{html:formattedPaidAt}}</div>
        </div>
        <div class="info-group">
          <div class="info-label">Stellar Transaction Hash</div>
          <div class="info-value">{{html:paymentTxHash}}</div>
        </div>
        <div class="info-group">
          <div class="info-label">Memo</div>
          <div class="info-value">{{html:memo}}</div>
        </div>
        <div class="info-group">
          <div class="info-label">Seller Address</div>
          <div class="info-value">{{html:sellerPublicKey}}</div>
        </div>
        {{#if payerPublicKey}}
        <div class="info-group">
          <div class="info-label">Payer Address</div>
          <div class="info-value">{{html:payerPublicKey}}</div>
        </div>
        {{/if}}
        {{#if customerName}}
        <div class="info-group" style="margin-bottom: 0;">
          <div class="info-label">Customer Name</div>
          <div class="info-value" style="font-family: inherit;">{{html:customerName}}</div>
        </div>
        {{/if}}
      </div>

      {{#if description}}
      <div class="info-group">
        <div class="info-label">Description / Notes</div>
        <div class="info-value" style="font-family: inherit; white-space: pre-wrap;">{{html:description}}</div>
      </div>
      {{/if}}
    </div>
    <div class="footer">
      Generated by <a href="{{url:frontendOrigin}}" target="_blank" rel="noopener noreferrer">Quittance</a> — Stellar Payment Proof Platform
    </div>
  </div>
</body>
</html>`,
  text: `QUITTANCE PAYMENT PROOF (SETTLEMENT CONFIRMED)
Invoice #{{text:invoiceIdShort}} — Status: PAID

AMOUNT SETTLED: {{text:amount}} {{text:assetCode}}
SETTLED AT: {{text:formattedPaidAt}}
INVOICE ID: {{text:invoiceId}}
TRANSACTION HASH: {{text:paymentTxHash}}
MEMO: {{text:memo}}
SELLER ADDRESS: {{text:sellerPublicKey}}
{{#if payerPublicKey}}
PAYER ADDRESS: {{text:payerPublicKey}}
{{/if}}
{{#if customerName}}
CUSTOMER: {{text:customerName}}
{{/if}}
{{#if description}}
DESCRIPTION / NOTES:
{{text:description}}
{{/if}}

Verified and settled on the Stellar blockchain.
Powered by Quittance`,
};

export const invoicePaymentRequestEngine = new EmailTemplateEngine(INVOICE_PAYMENT_REQUEST_DEFINITION);
export const paymentProofReceiptEngine = new EmailTemplateEngine(PAYMENT_PROOF_RECEIPT_DEFINITION);
