'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import ReportViewer from '@/components/ReportViewer';

interface ReportFile {
  name: string;
  date: string;
  size: number;
  type: string;
  ext: string;
}

function modeColor(type: string): string {
  switch (type) {
    case 'poi':      return '#00d4ff';
    case 'blast':    return '#ff4455';
    case 'conflict': return '#b44fff';
    case 'compare':  return '#ffd700';
    default:         return '#8888aa';
  }
}

function modeIcon(type: string): string {
  switch (type) {
    case 'poi':      return '🗺';
    case 'blast':    return '💥';
    case 'conflict': return '⚡';
    case 'compare':  return '🔍';
    default:         return '📄';
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function ReportsContent() {
  const searchParams = useSearchParams();
  const router       = useRouter();
  const activeFile   = searchParams.get('file');

  const [reports,  setReports]  = useState<ReportFile[]>([]);
  const [content,  setContent]  = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [filter,   setFilter]   = useState<string>('all');

  useEffect(() => {
    fetch('/api/reports')
      .then(r => r.json())
      .then(d => setReports(d.reports || []));
  }, []);

  useEffect(() => {
    if (!activeFile) { setContent(null); return; }
    setLoading(true);
    fetch(`/api/reports?file=${encodeURIComponent(activeFile)}`)
      .then(r => r.json())
      .then(d => { setContent(d.content || null); setLoading(false); })
      .catch(() => setLoading(false));
  }, [activeFile]);

  const filtered = filter === 'all' ? reports : reports.filter(r => r.type === filter);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0a0f' }}>
      <Sidebar />

      {/* Report list */}
      <div style={{
        width: '280px',
        borderRight: '1px solid #1e1e2e',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}>
        <div style={{ padding: '20px 16px 12px', borderBottom: '1px solid #1e1e2e' }}>
          <h1 style={{ color: '#e0e0ff', fontSize: '0.95rem', fontWeight: 600, margin: '0 0 12px' }}>Reports</h1>

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {['all','poi','blast','conflict','compare'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  background:   filter === f ? '#1e1e2e' : 'transparent',
                  border:       `1px solid ${filter === f ? '#555577' : '#1e1e2e'}`,
                  color:        filter === f ? '#e0e0ff' : '#8888aa',
                  padding:      '3px 8px',
                  borderRadius: '4px',
                  fontSize:     '0.7rem',
                  cursor:       'pointer',
                }}
              >
                {f === 'all' ? 'All' : modeIcon(f) + ' ' + f}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '24px 16px', color: '#8888aa', fontSize: '0.78rem', textAlign: 'center' }}>
              No reports found
            </div>
          ) : (
            filtered.map(r => {
              const isActive = r.name === activeFile;
              return (
                <div
                  key={r.name}
                  onClick={() => router.push(`/reports?file=${encodeURIComponent(r.name)}`)}
                  style={{
                    padding:     '12px 16px',
                    borderBottom:'1px solid #1a1a28',
                    cursor:      'pointer',
                    background:  isActive ? 'rgba(0,212,255,0.05)' : 'transparent',
                    borderLeft:  isActive ? `2px solid ${modeColor(r.type)}` : '2px solid transparent',
                  }}
                >
                  <div style={{ color: isActive ? '#e0e0ff' : '#c0c0e0', fontSize: '0.78rem', marginBottom: '4px', wordBreak: 'break-all' }}>
                    {r.name.replace(/^ghost-[a-z]+-/, '').replace(/\.(md|txt)$/, '')}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span style={{ color: modeColor(r.type), fontSize: '0.68rem' }}>
                      {modeIcon(r.type)} {r.type}
                    </span>
                    <span style={{ color: '#555577', fontSize: '0.68rem' }}>·</span>
                    <span style={{ color: '#8888aa', fontSize: '0.68rem' }}>{timeAgo(r.date)}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Report content */}
      <main style={{ flex: 1, padding: '28px 32px', overflowY: 'auto' }}>
        {loading ? (
          <div style={{ color: '#8888aa', fontSize: '0.85rem' }}>Loading report...</div>
        ) : content ? (
          <ReportViewer content={content} filename={activeFile || undefined} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
            <div style={{ textAlign: 'center', color: '#8888aa' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>👻</div>
              <div style={{ fontSize: '0.85rem' }}>Select a report to read</div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense>
      <ReportsContent />
    </Suspense>
  );
}
