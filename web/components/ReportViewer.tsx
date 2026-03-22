'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface Props {
  content: string;
  filename?: string;
}

export default function ReportViewer({ content, filename }: Props) {
  return (
    <div style={{ maxWidth: '900px', margin: '0 auto' }}>
      {filename && (
        <div style={{
          color: '#8888aa',
          fontSize: '0.75rem',
          marginBottom: '16px',
          padding: '8px 12px',
          background: '#111118',
          border: '1px solid #1e1e2e',
          borderRadius: '6px',
          fontFamily: 'monospace',
        }}>
          📄 {filename}
        </div>
      )}

      <div className="report-content" style={{ lineHeight: 1.7, fontSize: '0.875rem' }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code({ node, className, children, ...props }: any) {
              const match = /language-(\w+)/.exec(className || '');
              const isBlock = !props.inline;
              return isBlock && match ? (
                <SyntaxHighlighter
                  style={vscDarkPlus as any}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{
                    background: '#111118',
                    border: '1px solid #1e1e2e',
                    borderRadius: '6px',
                    fontSize: '0.8rem',
                    margin: '12px 0',
                  }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              ) : (
                <code
                  style={{
                    background: '#1e1e2e',
                    padding: '2px 6px',
                    borderRadius: '3px',
                    fontSize: '0.82em',
                    color: '#00d4ff',
                  }}
                  {...props}
                >
                  {children}
                </code>
              );
            },
            h1: ({ children }) => (
              <h1 style={{ color: '#00d4ff', fontSize: '1.3rem', marginTop: '2rem', marginBottom: '0.5rem', borderBottom: '1px solid #1e1e2e', paddingBottom: '8px' }}>
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 style={{ color: '#00d4ff', fontSize: '1.1rem', marginTop: '1.5rem', marginBottom: '0.4rem' }}>
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 style={{ color: '#e0e0ff', fontSize: '0.95rem', marginTop: '1rem', marginBottom: '0.3rem' }}>
                {children}
              </h3>
            ),
            table: ({ children }) => (
              <div style={{ overflowX: 'auto', margin: '12px 0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  {children}
                </table>
              </div>
            ),
            th: ({ children }) => (
              <th style={{ background: '#1e1e2e', color: '#00d4ff', padding: '8px 12px', textAlign: 'left', borderBottom: '1px solid #2a2a3e' }}>
                {children}
              </th>
            ),
            td: ({ children }) => (
              <td style={{ padding: '8px 12px', borderBottom: '1px solid #1a1a28', color: '#c0c0e0' }}>
                {children}
              </td>
            ),
            blockquote: ({ children }) => (
              <blockquote style={{ borderLeft: '3px solid #00d4ff', paddingLeft: '16px', color: '#8888aa', margin: '12px 0', fontStyle: 'italic' }}>
                {children}
              </blockquote>
            ),
            hr: () => (
              <hr style={{ border: 'none', borderTop: '1px solid #1e1e2e', margin: '20px 0' }} />
            ),
            strong: ({ children }) => (
              <strong style={{ color: '#e0e0ff', fontWeight: 600 }}>{children}</strong>
            ),
            p: ({ children }) => (
              <p style={{ color: '#c0c0e0', margin: '8px 0', lineHeight: 1.7 }}>{children}</p>
            ),
            li: ({ children }) => (
              <li style={{ color: '#c0c0e0', margin: '4px 0', lineHeight: 1.6 }}>{children}</li>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
