import { resolve } from 'path';
import { defineConfig } from 'vite';

// Production / private hardware-candidate build.
// Emits ONLY the main HUD (index.html). The simulator, session-injection
// controls, and QA scenario console are excluded by construction — they live
// in the separate simulator build (vite.simulator.config.js → dist-simulator/).
// scripts/verify-artifacts.js asserts this separation after every build.
export default defineConfig({
  define: {
    // Compile-time false: URL-token intake and simulator-only branches are
    // dead-code-eliminated from this bundle.
    __KSCAN_SIMULATOR_BUILD__: 'false',
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
