/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#FFFFFF',
        surface: '#FFFFFF',
        'surface-high': '#F9FAFB',
        border: '#D1D5DB',
        'border-light': '#E5E7EB',
        text: '#000000',
        'text-dim': '#4B5563',
        'text-muted': '#6B7280',
        accent: '#A52A2A',
        'accent-dim': '#8B2222',
        'ie-green': '#15803d',
        'ie-green-bg': '#dcfce7',
        'ie-green-border': '#86efac',
        'ie-red': '#dc2626',
        'ie-red-bg': '#fee2e2',
        'ie-red-border': '#fecaca',
        'ie-amber': '#d97706',
        'ie-amber-bg': '#fffbeb',
        'ie-amber-border': '#fde68a',
        'ie-blue': '#2563eb',
        'ie-blue-bg': '#eff6ff',
        'ie-blue-border': '#bfdbfe',
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
