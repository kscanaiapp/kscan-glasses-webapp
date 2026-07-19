// ESLint flat config — K Scan Meta HUD (framework-free Vite + vanilla JS).
// Focused on real defects, not style churn: undefined vars, unreachable
// code, duplicate keys, constant-condition mistakes, unsafe optional
// chaining, and unhandled-promise patterns. Formatting stays with the
// existing codebase conventions.

const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  history: 'readonly',
  fetch: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  CustomEvent: 'readonly',
  URLSearchParams: 'readonly',
  URL: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  console: 'readonly',
  Image: 'readonly',
  Blob: 'readonly',
  FileReader: 'readonly',
  performance: 'readonly',
  speechSynthesis: 'readonly',
  HTMLElement: 'readonly',
  DOMException: 'readonly',
  createImageBitmap: 'readonly',
  OffscreenCanvas: 'readonly',
  WebSocket: 'readonly',
};

const nodeGlobals = {
  process: 'readonly',
  globalThis: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
};

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-simulator/**',
      'public/mediapipe/**',
      '.vercel/**',
    ],
  },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...browserGlobals,
        __KSCAN_SIMULATOR_BUILD__: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unsafe-optional-chaining': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-shadow': 'warn',
      'no-throw-literal': 'error',
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
      'require-atomic-updates': 'warn',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'warn',
      'no-useless-assignment': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...nodeGlobals,
        fetch: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-unsafe-optional-chaining': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-throw-literal': 'error',
      'no-async-promise-executor': 'error',
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-useless-assignment': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    // Browser-driving scripts: page.evaluate callbacks execute inside the
    // page, so browser globals are legitimate alongside Node globals.
    files: ['scripts/browser-smoke.js', 'scripts/browser-smoke-companion.js'],
    languageOptions: {
      globals: {
        ...browserGlobals,
        getComputedStyle: 'readonly',
      },
    },
  },
  {
    files: ['vite.config.js', 'vite.simulator.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...nodeGlobals,
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
