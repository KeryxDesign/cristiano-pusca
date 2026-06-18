// Generatore OG image / thumbnail per ogni caso studio.
// Template: foto tonda a sinistra + kicker e titolo a destra, su brand dark.
// Aggiungere un caso = nessuna modifica qui: l'OG viene generato in automatico.
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

export const prerender = true;

export async function getStaticPaths() {
	const casi = await getCollection('casi-studio', ({ data }) => !data.draft);
	return casi.map((caso) => ({ params: { slug: caso.id }, props: { caso } }));
}

const ROOT = process.cwd();
const FONT_DIR = path.join(ROOT, 'node_modules/@fontsource/lexend/files');

// helper per costruire l'albero satori senza JSX
const el = (type: string, style: Record<string, unknown>, children?: unknown) => ({
	type,
	props: { style, ...(children !== undefined ? { children } : {}) },
});

export const GET: APIRoute = async ({ props }) => {
	const { caso } = props as { caso: { id: string; data: Record<string, any> } };
	const { title, kicker, ogImage, cover } = caso.data;

	// Foto nel tondo: ogImage se presente, altrimenti cover. webp -> png per satori.
	const imgRel = (ogImage ?? cover ?? '/img/cristiano-cta.webp').replace(/^\//, '');
	const imgBuf = await sharp(path.join(ROOT, 'public', imgRel))
		.resize(440, 440, { fit: 'cover', position: 'attention' })
		.png()
		.toBuffer();
	const imgData = `data:image/png;base64,${imgBuf.toString('base64')}`;

	const [reg, semi, bold] = await Promise.all([
		fs.readFile(path.join(FONT_DIR, 'lexend-latin-400-normal.woff')),
		fs.readFile(path.join(FONT_DIR, 'lexend-latin-600-normal.woff')),
		fs.readFile(path.join(FONT_DIR, 'lexend-latin-700-normal.woff')),
	]);

	const titleSize = title.length > 52 ? 46 : title.length > 38 ? 52 : 58;

	const tree = el(
		'div',
		{
			width: 1200,
			height: 630,
			display: 'flex',
			flexDirection: 'row',
			alignItems: 'center',
			backgroundColor: '#0c1220',
			padding: '64px 76px',
			fontFamily: 'Lexend',
		},
		[
			// tondo con foto
			el(
				'div',
				{
					display: 'flex',
					width: 440,
					height: 440,
					borderRadius: 220,
					overflow: 'hidden',
					flexShrink: 0,
					border: '8px solid #0ea5e9',
				},
				[
					{
						type: 'img',
						props: {
							src: imgData,
							width: 440,
							height: 440,
							style: { width: 440, height: 440, objectFit: 'cover' },
						},
					},
				],
			),
			// colonna testo a destra
			el(
				'div',
				{ display: 'flex', flexDirection: 'column', marginLeft: 64, flex: 1 },
				[
					el(
						'div',
						{ display: 'flex', color: '#38bdf8', fontSize: 26, fontWeight: 600, letterSpacing: 3, marginBottom: 22 },
						String(kicker).toUpperCase(),
					),
					el(
						'div',
						{ display: 'flex', color: '#ffffff', fontSize: titleSize, fontWeight: 700, lineHeight: 1.12, letterSpacing: -1 },
						title,
					),
					el(
						'div',
						{ display: 'flex', alignItems: 'center', marginTop: 40 },
						[
							el('div', { display: 'flex', width: 44, height: 4, backgroundColor: '#0ea5e9', borderRadius: 2, marginRight: 18 }, ' '),
							el('div', { display: 'flex', color: '#94a3b8', fontSize: 26, fontWeight: 400 }, 'cristianopusca.com'),
						],
					),
				],
			),
		],
	);

	const svg = await satori(tree as any, {
		width: 1200,
		height: 630,
		fonts: [
			{ name: 'Lexend', data: reg, weight: 400, style: 'normal' },
			{ name: 'Lexend', data: semi, weight: 600, style: 'normal' },
			{ name: 'Lexend', data: bold, weight: 700, style: 'normal' },
		],
	});

	const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();

	return new Response(png, {
		headers: {
			'Content-Type': 'image/png',
			'Cache-Control': 'public, max-age=31536000, immutable',
		},
	});
};
