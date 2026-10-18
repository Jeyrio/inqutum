import type { Metadata } from 'next';
import { Instrument_Serif } from 'next/font/google';
import { GeistSans } from 'geist/font/sans';
import { Toaster } from 'sonner';
import { MAIN_CONTENT_ID } from '@/lib/a11y';
import './globals.css';
import ApiStatusBanner from '@/components/ApiStatusBanner';
import FreighterNetworkListener from '@/components/FreighterNetworkListener';
import WalletSessionSync from '@/components/WalletSessionSync';

const instrumentSerif = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Quittance — Invoice on Stellar. Keep the proof.',
  description:
    'Create Stellar invoices, get paid on-chain, and download or email your payment proof — without exposing anyone else\'s wallet history.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${instrumentSerif.variable}`}>
      <body className={`${GeistSans.className} antialiased`}>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <Toaster position="top-right" richColors />
        <ApiStatusBanner />
        <FreighterNetworkListener />
        {children}
      </body>
    </html>
  );
}
