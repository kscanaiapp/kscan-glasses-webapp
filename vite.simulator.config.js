import { resolve } from 'path';
import { defineConfig } from 'vite';

// LOCAL QA / NON-PRODUCTION simulator build.
// Emits the main HUD plus the simulator control room into dist-simulator/.
// This artifact is for local QA only — it must never be deployed publicly.
// The simulator page carries a visible LOCAL QA / NON-PRODUCTION label.
export default defineConfig({
  define: {
    // Compile-time true: the LOCAL QA build may use URL-token intake and
    // simulator conveniences. This artifact must never be deployed publicly.
    __KSCAN_SIMULATOR_BUILD__: true,
    // Simulator is never the hardware candidate.
    __KSCAN_HARDWARE_CANDIDATE_BUILD__: false,
  },
  build: {
    outDir: 'dist-simulator',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        simulator: resolve(__dirname, 'simulator.html'),
        companion: resolve(__dirname, 'companion.html'),
      },
    },
  },
});
