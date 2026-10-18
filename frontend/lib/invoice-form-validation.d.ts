export type InvoiceFormField = 'amount' | 'sellerEmail' | 'customerEmail';
export type InvoiceFormErrors = Partial<Record<InvoiceFormField, string>>;

export function validateInvoiceForm(values: {
  amount: string;
  sellerEmail: string;
  customerEmail: string;
}): InvoiceFormErrors;

export function firstInvalidField(errors: InvoiceFormErrors): InvoiceFormField | null;
