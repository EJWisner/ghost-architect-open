import { listReports, listProjectSummaries, timeAgo, modeLabel } from '@/lib/ghost';
import Sidebar from '@/components/Sidebar';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const reports  = listReports().slice(0, 5);
  const projects = listProjectSummaries().slice(0, 4);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0a0f' }}>
      <Sidebar />

      <main style={{ flex: 1, padding: '32px', overflowY: 'auto' }}>
        {/* Header */}
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ color: '#00d4ff', fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>
            Ghost Architect
          </h1>
          <p style={{ color: '#8888aa', fontSize: '0.8rem', margin: '6px 0 0' }}>
            AI-powered codebase intelligence
          </p>
        </div>

        {/* Quick actions */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px', marginBottom: '36px' }}>
          {[
            { href: '/scan',     icon: '🔍', label: 'New Scan',       desc: 'Upload a codebase',           color: '#00d4ff' },
            { href: '/reports',  icon: '📄', label: 'Reports',        desc: `${reports.length} saved`,     color: '#00ff88' },
            { href: '/projects', icon: '📊', label: 'Projects',       desc: `${projects.length} tracked`,  color: '#b44fff' },
          ].map(({ href, icon, label, desc, color }) => (
            <Link key={href} href={href} style={{ textDecoration: 'none' }}>
              <div style={{
                background: '#111118',
                border: `1px solid #1e1e2e`,
                borderTop: `2px solid ${color}`,
                borderRadius: '8px',
                padding: '20px',
                cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}>
                <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>{icon}</div>
                <div style={{ color: color, fontWeight: 600, fontSize: '0.9rem' }}>{label}</div>
                <div style={{ color: '#8888aa', fontSize: '0.75rem', marginTop: '4px' }}>{desc}</div>
              </div>
            </Link>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
          {/* Recent reports */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h2 style={{ color: '#e0e0ff', fontSize: '0.9rem', fontWeight: 600, margin: 0 }}>Recent Reports</h2>
              <Link href="/reports" style={{ color: '#8888aa', fontSize: '0.75rem', textDecoration: 'none' }}>View all →</Link>
            </div>

            {reports.length === 0 ? (
              <EmptyState text="No reports yet — run a scan to get started" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {reports.map(r => (
                  <Link key={r.name} href={`/reports?file=${encodeURIComponent(r.name)}`} style={{ textDecoration: 'none' }}>
                    <div style={{
                      background: '#111118',
                      border: '1px solid #1e1e2e',
                      borderRadius: '6px',
                      padding: '12px 14px',
                      cursor: 'pointer',
                    }}>
                      <div style={{ color: '#e0e0ff', fontSize: '0.8rem', fontWeight: 500, marginBottom: '4px' }}>
                        {r.displayName}
                      </div>
                      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                        <span style={{ color: '#8888aa', fontSize: '0.7rem' }}>{modeLabel(r.type)}</span>
                        <span style={{ color: '#555577', fontSize: '0.7rem' }}>·</span>
                        <span style={{ color: '#8888aa', fontSize: '0.7rem' }}>{timeAgo(r.date)}</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Project intelligence */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h2 style={{ color: '#e0e0ff', fontSize: '0.9rem', fontWeight: 600, margin: 0 }}>Project Intelligence</h2>
              <Link href="/projects" style={{ color: '#8888aa', fontSize: '0.75rem', textDecoration: 'none' }}>View all →</Link>
            </div>

            {projects.length === 0 ? (
              <EmptyState text="No projects tracked yet — save a scan with a project label" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {projects.map(p => (
                  <div key={p.label} style={{
                    background: '#111118',
                    border: '1px solid #1e1e2e',
                    borderRadius: '6px',
                    padding: '12px 14px',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span style={{ color: '#e0e0ff', fontSize: '0.82rem', fontWeight: 500 }}>{p.label}</span>
                      <span style={{ color: '#00ff88', fontSize: '0.75rem' }}>{p.progress}%</span>
                    </div>
                    <ProgressBar value={p.progress} />
                    <div style={{ display: 'flex', gap: '12px', marginTop: '6px' }}>
                      <span style={{ color: '#8888aa', fontSize: '0.68rem' }}>{p.scanCount} scans</span>
                      {p.newIssues > 0 && (
                        <span style={{ color: '#ffd700', fontSize: '0.68rem' }}>⚠ {p.newIssues} new</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div style={{ height: '4px', background: '#1e1e2e', borderRadius: '2px', overflow: 'hidden' }}>
      <div style={{
        height: '100%',
        width: `${Math.min(100, value)}%`,
        background: value >= 75 ? '#00ff88' : value >= 40 ? '#ffd700' : '#ff4455',
        borderRadius: '2px',
        transition: 'width 0.3s',
      }} />
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{
      background: '#111118',
      border: '1px dashed #1e1e2e',
      borderRadius: '8px',
      padding: '24px',
      textAlign: 'center',
      color: '#8888aa',
      fontSize: '0.78rem',
    }}>
      {text}
    </div>
  );
}
