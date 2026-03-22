/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        ghost: {
          bg:       '#0a0a0f',
          surface:  '#111118',
          border:   '#1e1e2e',
          cyan:     '#00d4ff',
          magenta:  '#b44fff',
          green:    '#00ff88',
          yellow:   '#ffd700',
          red:      '#ff4455',
          muted:    '#4a4a6a',
          text:     '#e0e0ff',
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      }
    },
  },
  plugins: [],
};
