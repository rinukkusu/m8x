import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'm8x',
  description: 'Self-hosted workflow automation.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
