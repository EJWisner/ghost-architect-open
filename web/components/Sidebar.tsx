'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';

const nav = [
  { href: '/',          label: 'Dashboard',          icon: '👻' },
  { href: '/scan',      label: 'New Scan',            icon: '🔍' },
  { href: '/reports',   label: 'Reports',             icon: '📄' },
  { href: '/projects',  label: 'Project Intelligence', icon: '📊' },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside style={{
      width: '220px',
      minHeight: '100vh',
      background: '#111118',
      borderRight: '1px solid #1e1e2e',
      display: 'flex',
      flexDirection: 'column',
      padding: '0',
      flexShrink: 0,
    }}>
      {/* Logo */}
      <div style={{ padding: '24px 20px 20px', borderBottom: '1px solid #1e1e2e' }}>
        <div style={{ color: '#00d4ff', fontWeight: 700, fontSize: '1.1rem', letterSpacing: '0.05em' }}>
          GHOST
        </div>
        <div style={{ color: '#8888aa', fontSize: '0.7rem', letterSpacing: '0.15em', marginTop: '2px' }}>
          ARCHITECT
        </div>
        <div style={{ color: '#8888aa', fontSize: '0.65rem', marginTop: '4px' }}>
          v4.0.1
        </div>
      </div>

      {/* Nav */}
      <nav style={{ padding: '12px 0', flex: 1 }}>
        {nav.map(({ href, label, icon }) => {
          const active = pathname === href || (href !== '/' && pathname.startsWith(href));
          return (
            <Link key={href} href={href} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 20px',
                color: active ? '#00d4ff' : '#8888aa',
                background: active ? 'rgba(0, 212, 255, 0.06)' : 'transparent',
                borderLeft: active ? '2px solid #00d4ff' : '2px solid transparent',
                fontSize: '0.82rem',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}>
                <span>{icon}</span>
                <span>{label}</span>
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ padding: '16px 20px', borderTop: '1px solid #1e1e2e' }}>
        <div style={{ color: '#8888aa', fontSize: '0.65rem' }}>
          © 2026 Ghost Architect
        </div>
      </div>
    </aside>
  );
}
