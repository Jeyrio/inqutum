'use client';

import { useState } from 'react';
import { apiErrorMessage, invoiceApi, isApiUnavailableError } from '@/lib/api';
import { toast } from 'sonner';
import { Loader2, AlertTriangle } from 'lucide-react';
import { STELLAR_ASSETS, getAssetByCode } from '@/lib/assets';
import { useWalletStore } from '@/lib/store';
import { NETWORK_DISPLAY_NAME } from '@/lib/stellar';
import { showFreighterWrongNetworkPrompt } from './FreighterInstallPrompt';
import AssetLogo from './AssetLogo';
import ApiErrorState from './ApiErrorState';
import {
  firstInvalidField,
  validateInvoiceForm,
  type InvoiceFormErrors,
  type InvoiceFormField,
} from '@/lib/invoice-form-validation';
import { validateCreateInvoiceInput } from '@/lib/invoice-form-contract';

const FIELD_IDS: Record<InvoiceFormField, string> = {
  amount: 'invoice-amount',
  sellerEmail: 'invoice-seller-email',
  customerEmail: 'invoice-customer-email',
};

interface InvoiceFormProps {
  onSuccess?: (invoice: any) => void;
  userWallet?: string;
}

export default function InvoiceForm({ onSuccess, userWallet }: InvoiceFormProps) {
  const { publicKey, connected, network, freighterAvailable } = useWalletStore();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [assetCode, setAssetCode] = useState('XLM');
  const [description, setDescription] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [sellerEmail, setSellerEmail] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [apiError, setApiError] = useState<string | null>(null);
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [errors, setErrors] = useState<InvoiceFormErrors>({});

  /** aria wiring for a validated field: marks it invalid and links its error text. */
  const errorProps = (field: InvoiceFormField, hintId?: string) => {
    const describedBy = [errors[field] ? `${FIELD_IDS[field]}-error` : null, hintId]
      .filter(Boolean)
      .join(' ');
    return {
      id: FIELD_IDS[field],
      'aria-invalid': Boolean(errors[field]),
      'aria-describedby': describedBy || undefined,
    };
  };

  const fieldError = (field: InvoiceFormField) =>
    errors[field] ? (
      <p id={`${FIELD_IDS[field]}-error`} className="field-error">
        {errors[field]}
      </p>
    ) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

    const selectedAsset = getAssetByCode(assetCode);
    const validation = validateCreateInvoiceInput(
      {
        amount,
        assetCode,
        assetIssuer: selectedAsset?.issuer,
        expiresInDays,
        sellerName,
        sellerEmail,
        customerName,
        customerEmail,
        description,
      },
      userWallet
    );

    if (!validation.ok) {
      if (validation.walletError) {
        toast.error(validation.walletError);
        return;
      }
      setErrors(validation.errors as InvoiceFormErrors);
      if (validation.firstInvalid && validation.firstInvalid in FIELD_IDS) {
        document.getElementById(FIELD_IDS[validation.firstInvalid as InvoiceFormField])?.focus();
      }
      return;
    }

    setLoading(true);
    setApiError(null);
    try {
      const result = await invoiceApi.create(validation.payload);

      toast.success('Invoice created');
      onSuccess?.(result.data);
      setAmount('');
      setAssetCode('XLM');
      setDescription('');
      setSellerName('');
      setSellerEmail('');
      setCustomerName('');
      setCustomerEmail('');
      setExpiresInDays(7);
      setErrors({});
    } catch (error: any) {
      const message = apiErrorMessage(error, 'Failed to create invoice');
      if (isApiUnavailableError(error)) setApiError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {apiError && <ApiErrorState message={apiError} compact />}
      <div>
        <label className="label" htmlFor={FIELD_IDS.amount}>Invoice Amount *</label>
        <div className="flex gap-3 flex-col sm:flex-row">
          <input
            id="invoice-amount"
            name="amount"
            type="number"
            step="0.0000001"
            min="0.0000001"
            required
            aria-required="true"
            aria-describedby="invoice-amount-hint"
            className="input flex-1 text-2xl font-semibold"
            {...errorProps('amount')}
            placeholder="10.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <div className="relative">
            <label htmlFor="invoice-asset" className="sr-only">
              Asset
            </label>
            <select
              aria-label="Asset"
              value={assetCode}
              onChange={(e) => setAssetCode(e.target.value)}
              className="input w-full sm:w-40 text-sm font-semibold pl-12 pr-3 appearance-none cursor-pointer"
            >
              {STELLAR_ASSETS.map((asset) => (
                <option key={asset.code} value={asset.code}>
                  {asset.code}
                </option>
              ))}
            </select>
            {/*
              The logo repeats the asset code already announced by the select's
              own value, so it is hidden from assistive technology rather than
              read twice.
            */}
            <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
              <AssetLogo code={assetCode} size={24} showName={false} decorative />
            </div>
          </div>
        </div>
        {fieldError('amount')}
      </div>

      <div>
        <label className="label" htmlFor="invoice-description">Description</label>
        <textarea
          id="invoice-description"
          className="input min-h-[80px] resize-none text-sm"
          placeholder="What is this invoice for?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
        />
      </div>

      <div>
        <label className="label" htmlFor="invoice-expiry">Payment window</label>
        <select
          id="invoice-expiry"
          aria-describedby="invoice-expiry-hint"
          className="input w-full text-sm"
          value={expiresInDays}
          onChange={(event) => setExpiresInDays(Number(event.target.value))}
        >
          {[1, 3, 7, 14, 30].map((days) => (
            <option key={days} value={days}>
              {days} day{days === 1 ? '' : 's'}
            </option>
          ))}
        </select>
        <p id="invoice-expiry-hint" className="text-xs text-gray-500 mt-1">
          After this window the invoice stays in history but cannot be paid or verified.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="invoice-seller-name">Your name (optional)</label>
          <input
            id="invoice-seller-name"
            type="text"
            autoComplete="name"
            className="input text-sm"
            placeholder="Your name or business"
            value={sellerName}
            onChange={(e) => setSellerName(e.target.value)}
            maxLength={255}
          />
        </div>

        <div>
          <label className="label" htmlFor={FIELD_IDS.sellerEmail}>Your email (optional)</label>
          <input
            id="seller-email"
            name="sellerEmail"
            type="email"
            autoComplete="email"
            className="input text-sm"
            {...errorProps('sellerEmail')}
            placeholder="you@example.com"
            value={sellerEmail}
            onChange={(e) => setSellerEmail(e.target.value)}
            maxLength={255}
          />
          {fieldError('sellerEmail')}
        </div>
      </div>

      <div>
        <label className="label" htmlFor="invoice-customer-name">Client name (optional)</label>
        <input
          id="invoice-customer-name"
          type="text"
          className="input text-sm"
          placeholder="Client or company name"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          maxLength={255}
        />
      </div>

      <div>
        <label className="label" htmlFor={FIELD_IDS.customerEmail}>Client email (optional)</label>
        <input
          id="customer-email"
          name="customerEmail"
          type="email"
          aria-describedby="customer-email-hint"
          className="input text-sm"
          {...errorProps('customerEmail', 'invoice-customer-email-hint')}
          placeholder="client@example.com — for sending the invoice"
          value={customerEmail}
          onChange={(e) => setCustomerEmail(e.target.value)}
          maxLength={255}
        />
        {fieldError('customerEmail')}
        <p id="invoice-customer-email-hint" className="text-xs text-gray-500 mt-1">
          Used only to send the invoice or payment proof. Not required to create an invoice.
        </p>
      </div>

      <button
        type="submit"
        disabled={loading}
        aria-busy={loading}
        className="btn btn-primary w-full flex items-center justify-center gap-2 mt-6"
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
            Creating...
          </>
        ) : (
          'Create Invoice'
        )}
      </button>
    </form>
  );
}
