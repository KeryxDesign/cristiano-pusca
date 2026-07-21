// Single source of truth per il grafo identità JSON-LD del sito.
// Person (Cristiano Pusca) + Organization (BPDA) + Book + WebSite, collegati per @id.
// Importato da Layout.astro (site-wide) e da guida.astro (che ha un <head> proprio, fuori dal Layout).
// Dati verificati (fonte: public/llms.txt). PEC e logo omessi di proposito (vedi note HAWK).
export const identityGraph = {
	'@context': 'https://schema.org',
	'@graph': [
		{
			'@type': 'Person',
			'@id': 'https://cristianopusca.com/#cristiano-pusca',
			name: 'Cristiano Pusca',
			url: 'https://cristianopusca.com/',
			image: 'https://cristianopusca.com/cristiano-pusca.jpg',
			jobTitle: 'Analista comportamentale certificato',
			description:
				'Analista comportamentale certificato e studioso di neuroscienze cognitive, con oltre 35 anni di esperienza nelle vendite. Ideatore del metodo BEDo (Being, Doing).',
			worksFor: { '@id': 'https://cristianopusca.com/#bpda' },
			founder: { '@id': 'https://cristianopusca.com/#bpda' },
			knowsAbout: [
				'Analisi comportamentale',
				'Reti vendita',
				'Neuroscienze cognitive',
				'Assessment PDA',
				'Formazione commerciale',
			],
			sameAs: ['https://www.linkedin.com/in/cristianopusca/'],
		},
		{
			'@type': 'Organization',
			'@id': 'https://cristianopusca.com/#bpda',
			name: 'BPDA S.R.L.',
			url: 'https://cristianopusca.com/',
			founder: { '@id': 'https://cristianopusca.com/#cristiano-pusca' },
			vatID: 'IT04993860263',
			taxID: '04993860263',
			email: 'cristiano@cristianopusca.it',
			telephone: '+393408217120',
			address: {
				'@type': 'PostalAddress',
				streetAddress: 'Vicolo XX Settembre, 11',
				postalCode: '31100',
				addressLocality: 'Treviso',
				addressRegion: 'TV',
				addressCountry: 'IT',
			},
			contactPoint: {
				'@type': 'ContactPoint',
				telephone: '+393408217120',
				email: 'cristiano@cristianopusca.it',
				contactType: 'sales',
				areaServed: 'IT',
				availableLanguage: 'Italian',
			},
		},
		{
			'@type': 'Book',
			'@id': 'https://cristianopusca.com/#libro-la-fiducia',
			name: 'LA FIDUCIA, conditio sine qua non',
			author: { '@id': 'https://cristianopusca.com/#cristiano-pusca' },
			inLanguage: 'it',
		},
		{
			'@type': 'WebSite',
			'@id': 'https://cristianopusca.com/#website',
			url: 'https://cristianopusca.com/',
			name: 'Cristiano Pusca',
			inLanguage: 'it',
			publisher: { '@id': 'https://cristianopusca.com/#bpda' },
		},
	],
};
