import { defineConfig } from 'vite';

// Pages serves the project at this case-sensitive path, not at the domain root.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/ChemPhys_7TH_Platform/' : '/',
  server: { host: '0.0.0.0', allowedHosts: ['.e2b.app'] },
  preview: { host: '0.0.0.0', allowedHosts: ['.e2b.app'] },
}));
