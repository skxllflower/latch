import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

// Port differs from WAVdesk's 5173 (and Lathe's 5174) so the three guis
// can dev-run side by side.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5175, strictPort: true },
  clearScreen: false,
});
