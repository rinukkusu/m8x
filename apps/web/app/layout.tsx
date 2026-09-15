import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'm8x',
  description: 'Self-hosted workflow automation.',
};

/**
 * Without this a mobile browser lays the page out at 980px and scales the
 * result down, which makes every breakpoint in the app a decoration.
 *
 * `viewportFit: 'cover'` is what gives `env(safe-area-inset-*)` a value other
 * than zero, so bars pinned to the bottom of the screen can clear the home
 * indicator instead of sitting under it.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
