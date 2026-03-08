/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0c10',
        surface: '#12151c',
        'surface-high': '#1a1e28',
        border: '#252a36',
        'border-light': '#2f3545',
        text: '#e8eaed',
        'text-dim': '#8b92a0',
        'text-muted': '#565d6e',
        accent: '#c9a227',
        'accent-dim': '#8b7119',
        'ie-green': '#2ea043',
        'ie-green-bg': '#0d2818',
        'ie-green-border': '#1a4028',
        'ie-red': '#da3633',
        'ie-red-bg': '#2d1214',
        'ie-red-border': '#4a1c1e',
        'ie-amber': '#d29922',
        'ie-amber-bg': '#2d2008',
        'ie-amber-border': '#4a3410',
        'ie-blue': '#388bfd',
        'ie-blue-bg': '#0d1f3c',
        'ie-blue-border': '#163d6b',
      },
      fontFamily: {
        mono: ["'IBM Plex Mono'", "'Fira Code'", "'Cascadia Code'", 'monospace'],
        sans: ["'IBM Plex Sans'", "'Segoe UI'", 'system-ui', 'sans-serif'],
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shake: {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%, 60%': { transform: 'translateX(-8px)' },
          '40%, 80%': { transform: 'translateX(8px)' },
        },
        spin: {
          to: { transform: 'rotate(360deg)' },
        },
        pulse: {
          '0%, 100%': { opacity: '0.3' },
          '50%': { opacity: '1' },
        },
      },
      animation: {
        'fade-up': 'fadeUp 0.5s ease',
        'fade-up-fast': 'fadeUp 0.4s ease',
        shake: 'shake 0.4s ease',
        'spin-fast': 'spin 0.8s linear infinite',
        pulse: 'pulse 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
