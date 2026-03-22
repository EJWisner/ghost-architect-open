'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';

interface ProjectSummary {
  label: string;
  baselineDate: string;
  lastScan: string;
  scanCount: number;
  baseline: number;
  resolved: number;
  progress: number;
  newIssues: number;
  scans: Array<{ date: string; findingCount: number; resolved: number; newIssues: number }>;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState<ProjectSummary | null>(null);

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(d => { setProjects(d.projects || []); setLoading(false); });
  }, []);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0a0f' }}>
      <Sidebar />

      <main style={{ flex: 1, padding: '32px', overflowY: 'auto' }}>
        <h1 style={{ color: '#e0e0ff', fontSize: '1.1rem', fontWeight: 600, margin: '0 0 6px' }}>
          Project Intelligence
        </h1>
        <p style={{ color: '#8888aa', fontSize: '0.78rem', margin: '0 0 28px' }}>
          Remediation progress tracked across scans
        </p>

        {loading ? (
          <div style={{ color: '#8888aa', fontSize: '0.85rem' }}>Loading projects...</div>
        ) : projects.length === 0 ? (
          <div style={{
            background: '#111118',
            border: '1px dashed #1e1e2e',
            borderRadius: '8px',
            padding: '40px',
            textAlign: 'center',
            color: '#8888aa',
            fontSize: '0.82rem',
          }}>
            <div style={{ fontSize: '2rem', marginBottom: '12px' }}>📊</div>
            No projects tracked yet.<br />
            Run a scan and save it with a project label to start tracking remediation progress.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
            {projects.map(p => (
              <ProjectCard key={p.label} project={p} onSelect={() => setSelected(p)} />
            ))}
          </div>
        )}

        {/* Detail modal */}
        {selected && (
          <div
            onClick={() => setSelected(null)}
            style={{
              position: 'fixed', inset: 0,
              background: 'rgba(0,0,0,0.8)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              zIndex: 100, padding: '24px',
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: '#111118',
                border: '1px solid #1e1e2e',
                borderRadius: '10px',
                padding: '28px',
                maxWidth: '600px',
                width: '100%',
                maxHeight: '80vh',
                overflowY: 'auto',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 style={{ color: '#00d4ff', fontSize: '1rem', margin: 0 }}>{selected.label}</h2>
                <button
                  onClick={() => setSelected(null)}
                  style={{ background: 'none', border: 'none', color: '#8888aa', cursor: 'pointer', fontSize: '1.2rem' }}
                >×</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '20px' }}>
                {[
                  { label: 'Baseline',  value: selected.baselineDate },
                  { label: 'Last scan', value: selected.lastScan },
                  { label: 'Total scans', value: String(selected.scanCount) },
                  { label: 'Progress',  value: `${selected.progress}% remediated` },
                  { label: 'Baseline findings', value: String(selected.baseline) },
                  { label: 'Resolved', value: String(selected.resolved) },
                ].map(({ label, value }) => (
                  <div key={label} style={{ background: '#0a0a0f', border: '1px solid #1e1e2e', borderRadius: '6px', padding: '10px 12px' }}>
                    <div style={{ color: '#8888aa', fontSize: '0.68rem', marginBottom: '4px' }}>{label}</div>
                    <div style={{ color: '#e0e0ff', fontSize: '0.85rem' }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Scan history */}
              <h3 style={{ color: '#e0e0ff', fontSize: '0.82rem', marginBottom: '10px' }}>Scan History</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {selected.scans.map((sc, i) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: '#0a0a0f', border: '1px solid #1e1e2e',
                    borderRadius: '5px', padding: '8px 12px',
                    fontSize: '0.75rem',
                  }}>
                    <span style={{ color: '#c0c0e0' }}>{sc.date}</span>
                    <span style={{ color: '#8888aa' }}>{sc.findingCount} findings</span>
                    <span style={{ color: '#00ff88' }}>✓ {sc.resolved} resolved</span>
                    {sc.newIssues > 0 && <span style={{ color: '#ffd700' }}>⚠ {sc.newIssues} new</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function ProjectCard({ project: p, onSelect }: { project: ProjectSummary; onSelect: () => void }) {
  const progressColor = p.progress >= 75 ? '#00ff88' : p.progress >= 40 ? '#ffd700' : '#ff4455';

  return (
    <div
      onClick={onSelect}
      style={{
        background: '#111118',
        border: '1px solid #1e1e2e',
        borderRadius: '8px',
        padding: '20px',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div>
          <div style={{ color: '#e0e0ff', fontWeight: 600, fontSize: '0.9rem', marginBottom: '4px' }}>{p.label}</div>
          <div style={{ color: '#8888aa', fontSize: '0.7rem' }}>
            {p.scanCount} scan{p.scanCount !== 1 ? 's' : ''} · baseline {p.baselineDate}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: progressColor, fontWeight: 700, fontSize: '1.1rem' }}>{p.progress}%</div>
          <div style={{ color: '#8888aa', fontSize: '0.65rem' }}>remediated</div>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: '5px', background: '#1e1e2e', borderRadius: '3px', overflow: 'hidden', marginBottom: '12px' }}>
        <div style={{
          height: '100%',
          width: `${Math.min(100, p.progress)}%`,
          background: progressColor,
          borderRadius: '3px',
          transition: 'width 0.4s',
        }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
        <span style={{ color: '#8888aa' }}>
          {p.baseline} baseline · {p.resolved} resolved
        </span>
        {p.newIssues > 0 && (
          <span style={{ color: '#ffd700' }}>⚠ {p.newIssues} new</span>
        )}
      </div>
    </div>
  );
}
