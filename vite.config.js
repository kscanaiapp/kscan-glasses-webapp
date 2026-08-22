import { resolve } from 'path';
import { defineConfig } from 'vite';

// Production build (frozen public investor demo).
// Emits ONLY the main HUD (index.html) into dist-production/. The simulator,
// session-injection controls, and QA scenario console are excluded by
// construction — they live in the separate simulator build
// (vite.simulator.config.js → dist-simulator/). The private hardware
// candidate is a THIRD artifact (vite.hardware.config.js → dist-hardware/).
// scripts/verify-artifacts.js asserts this separation after every build.
//
// Build-flag types are boolean literals by contract. Quoted strings here are
// a defect class (see takeover audit: 'true' string made the candidate path
// unreachable) and are regression-tested in scripts/wearable-integration-tests.js.
export default defineConfig({
  define: {
    // Compile-time false: URL-token intake and simulator-only branches are
    // dead-code-eliminated from this bundle.
    __KSCAN_SIMULATOR_BUILD__: false,
    // This artifact is the public demo — never the hardware candidate.
    __KSCAN_HARDWARE_CANDIDATE_BUILD__: false,
  },
  build: {
    outDir: 'dist-production',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
