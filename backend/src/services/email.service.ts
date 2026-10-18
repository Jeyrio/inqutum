/**
 * Email Service with Contextual Template Rendering & Preview (Issue #36).
 *
 * Implements safe email generation, visual previewing for senders, and delivery abstractions.
 * Freelancer-supplied fields (client name, notes/descriptions) are rendered exclusively
 * through the contextual-escaping template engine, eliminating template and HTML injection risks.
 */

import type { StoredInvoice } from '../storage/invoice-storage';
import { safeFrontendOrigin } from '../security/content-safety';
import {
  invoicePaymentRequestEngine,
  paymentProofReceiptEngine,
} from '../templates/invoice-email-templates';
import type { RenderedEmail, TemplateContextData } from '../templates/email-template-engine';
import {
  MemoryCheckpointStore,
  fingerprintOf,
  runWithCheckpoint,
  type CheckpointStore,
} from '../recovery/side-effect-checkpoint';

export type EmailTemplateType = 'payment_request' | 'payment_proof';

export interface EmailRenderOptions {
  frontendUrl?: string;
  senderAddress?: string;
}

export interface EmailPreviewResult {
  templateType: EmailTemplateType;
  recipient: string;
  sender: string;
  subject: string;
  html: string;
  text: string;
}

export interface SentEmailRecord {
  id: string;
  invoiceId: string;
  templateType: EmailTemplateType;
  recipient: string;
  subject: string;
  html: string;
  text: string;
  sentAt: string;
}

export interface EmailTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ messageId: string }>;
}

/**
 * In-memory email transport for testing and local MVP environments.
 */
export class MemoryEmailTransport implements EmailTransport {
  public sentEmails: SentEmailRecord[] = [];

  async sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ messageId: string }> {
    const messageId = `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.sentEmails.push({
      id: messageId,
      invoiceId: '',
      templateType: 'payment_request',
      recipient: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      sentAt: new Date().toISOString(),
    });
    return { messageId };
  }

  clear(): void {
    this.sentEmails = [];
  }
}

export class EmailService {
  constructor(
    private readonly transport: EmailTransport = new MemoryEmailTransport(),
    private readonly defaultSender = 'noreply@quittance.app',
    /** Recovery checkpoints for keyed sends (#289). */
    private readonly checkpoints: CheckpointStore = new MemoryCheckpointStore()
  ) {}

  /**
   * Prepares template data dictionary from invoice record.
   * Time Complexity: O(1)
   * Space Complexity: O(1)
   */
  private buildTemplateData(invoice: StoredInvoice, frontendUrl?: string): TemplateContextData {
    const origin = safeFrontendOrigin(frontendUrl || process.env.FRONTEND_URL);
    const invoiceIdShort = invoice.id.substring(0, 8).toUpperCase();
    const formattedExpiresAt = invoice.expiresAt ? new Date(invoice.expiresAt).toUTCString() : '';
    const formattedPaidAt = invoice.paidAt ? new Date(invoice.paidAt).toUTCString() : '';

    return {
      invoiceId: invoice.id,
      invoiceIdShort,
      amount: String(invoice.amount),
      assetCode: invoice.assetCode,
      assetIssuer: invoice.assetIssuer || '',
      memo: invoice.memo,
      sellerName: invoice.sellerName || 'Freelancer',
      sellerPublicKey: invoice.sellerPublicKey,
      customerName: invoice.customerName || '',
      customerEmail: invoice.customerEmail || '',
      description: invoice.description || '',
      formattedExpiresAt,
      formattedPaidAt,
      paymentTxHash: invoice.paymentTxHash || '',
      payerPublicKey: invoice.payerPublicKey || '',
      payerName: invoice.payerName || '',
      paymentUrl: `${origin}/pay/${encodeURIComponent(invoice.id)}`,
      frontendOrigin: origin,
      recipientEmail: invoice.customerEmail || '',
    };
  }

  /**
   * Renders the complete safe email payload using contextual escaping.
   * Time Complexity: O(N + M)
   * Space Complexity: O(N + M)
   */
  renderEmail(
    invoice: StoredInvoice,
    templateType: EmailTemplateType = 'payment_request',
    options: EmailRenderOptions = {}
  ): RenderedEmail {
    const data = this.buildTemplateData(invoice, options.frontendUrl);
    const engine =
      templateType === 'payment_proof' ? paymentProofReceiptEngine : invoicePaymentRequestEngine;

    const rendered = engine.render(data);
    rendered.from = options.senderAddress || this.defaultSender;
    rendered.recipient = (data.customerEmail as string) || (data.recipientEmail as string) || '';
    return rendered;
  }

  /**
   * Generates a preview for the freelancer to review exact email contents before sending.
   */
  getPreview(
    invoice: StoredInvoice,
    templateType: EmailTemplateType = 'payment_request',
    options: EmailRenderOptions = {}
  ): EmailPreviewResult {
    const rendered = this.renderEmail(invoice, templateType, options);
    return {
      templateType,
      recipient: rendered.recipient || '',
      sender: rendered.from || this.defaultSender,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
  }

  /**
   * Sends the rendered invoice email safely using the compiled template.
   */
  async sendInvoiceEmail(
    invoice: StoredInvoice,
    templateType: EmailTemplateType = 'payment_request',
    options: EmailRenderOptions & {
      recipientEmail?: string;
      /**
       * When set, the send is checkpointed (#289): a retry with the same key
       * returns the first result instead of emailing the client twice.
       */
      idempotencyKey?: string;
    } = {}
  ): Promise<{ success: boolean; messageId: string; recipient: string; subject: string }> {
    const recipient = options.recipientEmail || invoice.customerEmail;
    if (!recipient) {
      throw new Error('Recipient email address is required');
    }

    if (templateType === 'payment_proof' && invoice.status !== 'PAID') {
      throw new Error('Payment proof can only be sent for PAID invoices');
    }

    const rendered = this.renderEmail(invoice, templateType, options);
    const from = options.senderAddress || this.defaultSender;

    const mail = { from, to: recipient, subject: rendered.subject, html: rendered.html, text: rendered.text };
    const result = options.idempotencyKey
      ? await runWithCheckpoint(
          this.checkpoints,
          // Scoped to the invoice so one key cannot replay another invoice's result.
          {
            key: `invoice-email:${invoice.id}:${options.idempotencyKey}`,
            effect: 'email.invoice',
            fingerprint: fingerprintOf([mail.from, mail.to, mail.subject, mail.html, mail.text]),
          },
          () => this.transport.sendMail(mail)
        )
      : await this.transport.sendMail(mail);

    return {
      success: true,
      messageId: result.messageId,
      recipient,
      subject: rendered.subject,
    };
  }
}

export const emailService = new EmailService();
