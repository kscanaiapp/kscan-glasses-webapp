import { resolve } from 'path';
import { defineConfig } from 'vite';

// PRIVATE HARDWARE CANDIDATE build.
// This is the production build for the Meta physical device test candidate.
// It is distinct from:
//   - the public investor demo (vite.config.js → dist-production/, frozen, mock-only)
//   - the simulator build (vite.simulator.config.js → dist-simulator/, LOCAL QA)
//
// This artifact must never be deployed to the public demo URL.
//
// Build-flag types are boolean literals by contract (quoted strings are a
// known defect class — regression-tested in scripts/wearable-integration-tests.js).
export default defineConfig({
  define: {
    __KSCAN_SIMULATOR_BUILD__: false,
    __KSCAN_HARDWARE_CANDIDATE_BUILD__: true,
  },
  build: {
    outDir: 'dist-hardware',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
