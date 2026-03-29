// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  site: 'https://batuhanhangun.com',

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

  adapter: cloudflare({ prerenderEnvironment: 'node' }),
});
