'use client';

import { useState, useRef, useCallback } from 'react';
import Sidebar from '@/components/Sidebar';
import ReportViewer from '@/components/ReportViewer';

type Mode    = 'poi' | 'blast' | 'conflict';
type Status  = 'idle' | 'uploading' | 'scanning' | 'done' | 'error';

const MODES: { value: Mode; label: string; icon: string; desc: string; color: string }[] = [
  { value: 'poi',      icon: '🗺',  label: 'Points of Interest', desc: 'Red flags, landmarks, dead zones, fault lines',   color: '#00d4ff' },
  { value: 'conflict', icon: '⚡',  label: 'Conflict Detection', desc: 'Contract mismatches, schema errors, config bugs', color: '#b44fff' },
  { value: 'blast',    icon: '💥',  label: 'Blast Radius',       desc: 'Impact map + rollback plan for a specific change', color: '#ff4455' },
];

export default function ScanPage() {
  const [mode,      setMode]      = useState<Mode>('poi');
  const [file,      setFile]      = useState<File | null>(null);
  const [apiKey,    setApiKey]    = useState('');
  const [status,    setStatus]    = useState<Status>('idle');
  const [report,    setReport]    = useState('');
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [error,     setError]     = useState('');
  const [dragging,  setDragging]  = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reportRef = useRef<HTMLDivElement>(null);

  const handleFile = useCallback((f: File) => {
    if (!f.name.endsWith('.zip')) {
      setError('Please upload a ZIP file');
      return;
    }
    setFile(f);
    setError('');
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const runScan = async () => {
    if (!file) return;
    setStatus('uploading');
    setReport('');
    setError('');
    setFileCount(null);

    const form = new FormData();
    form.append('file', file);
    form.append('mode', mode);
    if (apiKey) form.append('apiKey', apiKey);

    try {
      setStatus('scanning');
      const res = await fetch('/api/scan', { method: 'POST', body: form });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Scan failed');
      }

      const count = res.headers.get('X-File-Count');
      if (count) setFileCount(parseInt(count));

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        setReport(buffer);
        // Auto-scroll
        setTimeout(() => {
          reportRef.current?.scrollTo({ top: reportRef.current.scrollHeight, behavior: 'smooth' });
        }, 50);
      }

      setStatus('done');
    } catch (err: any) {
      setError(err.message);
      setStatus('error');
    }
  };

  const selectedMode = MODES.find(m => m.value === mode)!;
  const canRun = file && status !== 'scanning' && status !== 'uploading';

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0a0a0f' }}>
      <Sidebar />

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Config panel */}
        <div style={{
          padding: '24px 28px',
          borderBottom: '1px solid #1e1e2e',
          background: '#111118',
          flexShrink: 0,
        }}>
          <h1 style={{ color: '#e0e0ff', fontSize: '1rem', fontWeight: 600, margin: '0 0 20px' }}>
            New Scan
          </h1>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', alignItems: 'start' }}>
            {/* Mode selector */}
            <div>
              <label style={{ color: '#8888aa', fontSize: '0.72rem', display: 'block', marginBottom: '8px' }}>
                SCAN MODE
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {MODES.map(m => (
                  <div
                    key={m.value}
                    onClick={() => setMode(m.value)}
                    style={{
                      padding: '10px 12px',
                      border: `1px solid ${mode === m.value ? m.color : '#1e1e2e'}`,
                      borderRadius: '6px',
                      cursor: 'pointer',
                      background: mode === m.value ? `rgba(${m.color === '#00d4ff' ? '0,212,255' : m.color === '#b44fff' ? '180,79,255' : '255,68,85'},0.06)` : 'transparent',
                    }}
                  >
                    <div style={{ color: mode === m.value ? m.color : '#c0c0e0', fontSize: '0.8rem', fontWeight: 500 }}>
                      {m.icon} {m.label}
                    </div>
                    <div style={{ color: '#8888aa', fontSize: '0.68rem', marginTop: '2px' }}>{m.desc}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* File upload */}
            <div>
              <label style={{ color: '#8888aa', fontSize: '0.72rem', display: 'block', marginBottom: '8px' }}>
                CODEBASE (ZIP)
              </label>
              <div
                onClick={() => inputRef.current?.click()}
                onDrop={onDrop}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                style={{
                  border: `2px dashed ${dragging ? selectedMode.color : file ? '#555577' : '#1e1e2e'}`,
                  borderRadius: '8px',
                  padding: '28px 16px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: dragging ? `rgba(0,212,255,0.03)` : 'transparent',
                  transition: 'all 0.2s',
                }}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept=".zip"
                  style={{ display: 'none' }}
                  onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
                />
                {file ? (
                  <>
                    <div style={{ color: '#00ff88', fontSize: '1.2rem', marginBottom: '6px' }}>✓</div>
                    <div style={{ color: '#e0e0ff', fontSize: '0.78rem' }}>{file.name}</div>
                    <div style={{ color: '#8888aa', fontSize: '0.68rem', marginTop: '4px' }}>
                      {(file.size / 1024).toFixed(0)} KB
                      {fileCount && ` · ${fileCount} files loaded`}
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: '1.5rem', marginBottom: '8px' }}>🗜</div>
                    <div style={{ color: '#8888aa', fontSize: '0.78rem' }}>Drop ZIP here or click to browse</div>
                    <div style={{ color: '#555577', fontSize: '0.68rem', marginTop: '4px' }}>node_modules excluded automatically</div>
                  </>
                )}
              </div>
            </div>

            {/* API key + run */}
            <div>
              <label style={{ color: '#8888aa', fontSize: '0.72rem', display: 'block', marginBottom: '8px' }}>
                API KEY <span style={{ color: '#555577' }}>(optional if ANTHROPIC_API_KEY set)</span>
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                style={{
                  width: '100%',
                  background: '#0a0a0f',
                  border: '1px solid #1e1e2e',
                  borderRadius: '6px',
                  padding: '10px 12px',
                  color: '#e0e0ff',
                  fontSize: '0.78rem',
                  fontFamily: 'monospace',
                  outline: 'none',
                  marginBottom: '12px',
                  boxSizing: 'border-box',
                }}
              />

              <button
                onClick={runScan}
                disabled={!canRun}
                style={{
                  width: '100%',
                  background: canRun ? selectedMode.color : '#1e1e2e',
                  color: canRun ? '#000' : '#8888aa',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '12px',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  cursor: canRun ? 'pointer' : 'not-allowed',
                  fontFamily: 'monospace',
                  transition: 'all 0.2s',
                }}
              >
                {status === 'uploading' ? 'Uploading...' :
                 status === 'scanning'  ? '⚡ Scanning...' :
                 `Run ${selectedMode.label}`}
              </button>

              {error && (
                <div style={{ color: '#ff4455', fontSize: '0.72rem', marginTop: '8px' }}>{error}</div>
              )}
            </div>
          </div>
        </div>

        {/* Report output */}
        <div ref={reportRef} style={{ flex: 1, padding: '28px 32px', overflowY: 'auto' }}>
          {status === 'scanning' && !report && (
            <div style={{ color: '#8888aa', fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ color: selectedMode.color }}>⚡</span>
              Ghost is reading your codebase...
            </div>
          )}

          {report && (
            <ReportViewer content={report} />
          )}

          {status === 'idle' && !report && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60%' }}>
              <div style={{ textAlign: 'center', color: '#8888aa' }}>
                <div style={{ fontSize: '3rem', marginBottom: '12px' }}>👻</div>
                <div style={{ fontSize: '0.85rem' }}>Upload a ZIP file and run a scan</div>
                <div style={{ fontSize: '0.72rem', marginTop: '6px', color: '#555577' }}>
                  Results stream in real-time as Ghost reads your code
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
