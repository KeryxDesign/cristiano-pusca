// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://cristianopusca.com',
  server: { port: 4325 },
  redirects: {
    '/casi-studio/mario-e-luigi': '/casi-studio/due-selezioni-due-esiti',
  },
  integrations: [
    // /proposta-home e' una demo interna noindex: fuori dal sitemap
    sitemap({ filter: (page) => !page.includes('/proposta-home') }),
  ],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  },
});
