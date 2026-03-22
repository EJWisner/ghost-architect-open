import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Ghost Architect',
  description: 'AI-powered codebase intelligence',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
