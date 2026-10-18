/** @type {import('next').NextConfig} */
const stellarNetwork = (process.env.NEXT_PUBLIC_STELLAR_NETWORK || 'TESTNET').toUpperCase();
if (!['TESTNET', 'PUBLIC'].includes(stellarNetwork)) {
  throw new Error('NEXT_PUBLIC_STELLAR_NETWORK must be TESTNET or PUBLIC');
}

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  images: {
    domains: ['localhost', 'assets.coingecko.com'],
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'assets.coingecko.com',
        pathname: '/coins/images/**',
      },
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Script/style sources are left to Next.js; this subset blocks framing,
          // plugin content, <base> hijacking and form posts to other origins.
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
