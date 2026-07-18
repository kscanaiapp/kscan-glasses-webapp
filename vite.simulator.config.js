import { resolve } from 'path';
import { defineConfig } from 'vite';

// LOCAL QA / NON-PRODUCTION simulator build.
// Emits the main HUD plus the simulator control room into dist-simulator/.
// This artifact is for local QA only — it must never be deployed publicly.
// The simulator page carries a visible LOCAL QA / NON-PRODUCTION label.
export default defineConfig({
  build: {
    outDir: 'dist-simulator',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        simulator: resolve(__dirname, 'simulator.html'),
      },
    },
  },
});
