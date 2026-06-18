import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Sezione "Casi studio" — blog scalabile. Aggiungere un caso = un nuovo .md qui dentro.
const casiStudio = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/casi-studio' }),
	schema: z.object({
		title: z.string(), // titolo breve (card, breadcrumb, <title>)
		headline: z.string(), // titolo lungo dell'hero (H1)
		kicker: z.string().default('UN CASO REALE'),
		hook: z.string(), // sottotitolo hero
		excerpt: z.string(), // paragrafo della card in indice
		order: z.number().default(99), // ordinamento in indice (1 = primo)
		cover: z.string().optional(), // immagine card, path da /public
		ogImage: z.string().optional(), // foto nel tondo dell'OG/thumbnail (default: cover)
		ctaHook: z.string(), // titolo della CTA finale
		draft: z.boolean().default(false),
	}),
});

export const collections = { 'casi-studio': casiStudio };
