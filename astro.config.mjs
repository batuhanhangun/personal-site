// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://batuhanhangun.com',
  output: 'static',

  // Prefetch internal links on hover/visibility for instant navigations
  prefetch: {
    prefetchAll: false,       // opt-in per link with data-astro-prefetch
    defaultStrategy: 'hover',
  },

  vite: {
    plugins: [tailwindcss()],
    build: {
      sourcemap: false,
    },
  },
});
