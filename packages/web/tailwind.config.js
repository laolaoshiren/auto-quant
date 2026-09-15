/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Terminal chrome
        base: {
          950: '#08090c',
          900: '#0b0d12',
          850: '#0f1116',
          800: '#14161d',
          750: '#191c24',
          700: '#21242e',
          600: '#2b2f3a',
          500: '#3a3f4d',
        },
        ink: {
          hi: '#e8ecf3',
          mid: '#a7b0c0',
          lo: '#6b7486',
          faint: '#464e5e',
        },
        up: '#22c98a',
        down: '#f4525f',
        accent: '#4d8dff',
        warn: '#f5a524',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', '14px'],
        xs: ['11px', '16px'],
        sm: ['12px', '18px'],
        base: ['13px', '20px'],
        md: ['14px', '21px'],
        lg: ['16px', '24px'],
        xl: ['20px', '28px'],
        '2xl': ['26px', '32px'],
      },
      boxShadow: {
        panel: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.8)',
      },
      keyframes: {
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
        slideIn: {
          from: { opacity: '0', transform: 'translateY(-6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        pulseSoft: 'pulseSoft 1.6s ease-in-out infinite',
        slideIn: 'slideIn 140ms ease-out',
      },
    },
  },
  plugins: [],
};
