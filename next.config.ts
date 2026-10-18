import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    '192.168.100.142',
    '192.168.100.*',
    '192.168.*.*',
    '172.24.0.1',
    '192.168.30.1',
    '192.168.5.1',
    'localhost',
    '127.0.0.1',
  ],
  async redirects() {
    return [
      { source: '/dashboard', destination: '/', permanent: false },
      { source: '/home', destination: '/', permanent: false },
      { source: '/cockpit', destination: '/', permanent: false },
      { source: '/expenses', destination: '/transactions', permanent: false },
      { source: '/expense', destination: '/transactions', permanent: false },
      { source: '/flow', destination: '/transactions', permanent: false },
      { source: '/receipt', destination: '/receipt-prices', permanent: false },
      { source: '/receipts', destination: '/receipt-prices', permanent: false },
      { source: '/ai', destination: '/receipt-prices', permanent: false },
      { source: '/ask-ai', destination: '/receipt-prices', permanent: false },
      { source: '/stock', destination: '/investments', permanent: false },
      { source: '/stocks', destination: '/investments', permanent: false },
      { source: '/trade', destination: '/investments', permanent: false },
      { source: '/trades', destination: '/investments', permanent: false },
      { source: '/budgeting', destination: '/budget', permanent: false },
      { source: '/trip', destination: '/trips', permanent: false },
      { source: '/invoice', destination: '/invoices', permanent: false },
      { source: '/claims', destination: '/invoices', permanent: false },
      { source: '/setting', destination: '/settings', permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, max-age=0',
          },
          {
            key: 'Pragma',
            value: 'no-cache',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
