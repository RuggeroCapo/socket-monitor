import type { ReactNode } from 'react';
import Nav from '@/components/Nav';
import './globals.css';

export const metadata = {
  title: 'Vine Pulse',
  description: 'Monitoraggio in tempo reale dei prodotti Amazon Vine Italia',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
