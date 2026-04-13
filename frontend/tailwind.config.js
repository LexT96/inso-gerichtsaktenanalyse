/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#F8F9FA',
        surface: '#FFFFFF',
        'surface-high': '#F3F4F6',
        border: '#E5E7EB',
        'border-light': '#F3F4F6',
        text: '#111827',
        'text-dim': '#2D3748',
        'text-muted': '#4A5568',
        accent: '#023055',
        'accent-dim': '#011e3a',
        'ie-green': '#16a34a',
        'ie-green-bg': '#f0fdf4',
        'ie-green-border': '#bbf7d0',
        'ie-red': '#dc2626',
        'ie-red-bg': '#fef2f2',
        'ie-red-border': '#fecaca',
        'ie-amber': '#d97706',
        'ie-amber-bg': '#fffbeb',
        'ie-amber-border': '#fde68a',
        'ie-blue': '#2563eb',
        'ie-blue-bg': '#eff6ff',
        'ie-blue-border': '#bfdbfe',
      },
      fontFamily: {
        mono: ["'Geist Mono'", "'IBM Plex Mono'", "'Fira Code'", 'monospace'],
        sans: ["'DM Sans'", "'IBM Plex Sans'", 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'card': '0 1px 3px 0 rgb(0 0 0 / 0.04), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        'card-hover': '0 4px 6px -1px rgb(0 0 0 / 0.06), 0 2px 4px -2px rgb(0 0 0 / 0.04)',
        'elevated': '0 4px 12px -2px rgb(0 0 0 / 0.08), 0 2px 4px -2px rgb(0 0 0 / 0.04)',
        'dropdown': '0 8px 24px -4px rgb(0 0 0 / 0.12), 0 4px 8px -4px rgb(0 0 0 / 0.06)',
      },
      borderRadius: {
        'card': '8px',
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
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
        'fade-up': 'fadeUp 0.4s ease-out',
        'fade-up-fast': 'fadeUp 0.3s ease-out',
        'fade-in': 'fadeIn 0.3s ease-out',
        shake: 'shake 0.4s ease',
        'spin-fast': 'spin 0.8s linear infinite',
        pulse: 'pulse 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
