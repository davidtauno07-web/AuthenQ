/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#050505',
          900: '#0b0b0c',
          850: '#111113',
          800: '#17171a',
          700: '#232327',
          600: '#34343a',
          500: '#4b4b52',
          400: '#6c6c75',
          300: '#9a9aa2',
          200: '#c7c7cc',
          100: '#e6e6e9',
          50: '#f5f5f7',
        },
        state: {
          pass: '#1f9d55',
          warn: '#b7791f',
          fail: '#c53030',
          idle: '#6c6c75',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['JetBrains Mono', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        metric: ['2.75rem', { lineHeight: '1', letterSpacing: '-0.03em' }],
      },
    },
  },
  plugins: [],
};
