export default {
	async fetch(request, env) {
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders(env, request) });
		}

		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed' }, 405, env, request);
		}

		try {
			const { email, score, cost, newsletter, answers } = await request.json();

			if (!email || score == null || !cost) {
				return jsonResponse({ error: 'Missing required fields' }, 400, env, request);
			}

			// 1. Save to Mailchimp (subscriber + merge fields + tag)
			const mcResult = await addToMailchimp(env, email, score, cost, newsletter);
			if (!mcResult.ok) {
				console.error('Mailchimp error (non-blocking):', mcResult.error);
			}

			// 2. Send results email to user via Resend
			const emailResult = await sendResultsEmail(env, email, score, cost);
			if (!emailResult.ok) {
				console.error('Resend user email error:', emailResult.error);
			}

			// 3. Send notification to owner with full details
			const notifyResult = await sendNotifyEmail(env, email, score, cost, answers);
			if (!notifyResult.ok) {
				console.error('Resend notify error:', notifyResult.error);
			}

			return jsonResponse({ success: true, mailchimp: mcResult.ok }, 200, env, request);
		} catch (err) {
			console.error('Worker error:', err);
			return jsonResponse({ error: 'Internal error' }, 500, env, request);
		}
	},
};

// ── Mailchimp ──────────────────────────────────────────────

async function addToMailchimp(env, email, score, cost, newsletter) {
	const server = env.MAILCHIMP_SERVER;
	const listId = env.MAILCHIMP_LIST_ID;
	const apiKey = env.MAILCHIMP_API_KEY;
	const authHeader = `Basic ${btoa('anystring:' + apiKey)}`;
	const emailHash = await md5(email.toLowerCase());
	const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${emailHash}`;

	const res = await fetch(url, {
		method: 'PUT',
		headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email_address: email,
			status_if_new: newsletter ? 'pending' : 'transactional',
			merge_fields: { SCORE: String(score), COSTO: String(cost) },
		}),
	});

	if (!res.ok) {
		const body = await res.json();
		return { ok: false, error: body.detail || body.title };
	}

	await fetch(`https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${emailHash}/tags`, {
		method: 'POST',
		headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
		body: JSON.stringify({ tags: [{ name: 'scanner-done', status: 'active' }] }),
	});

	return { ok: true };
}

// ── Results email to user ──────────────────────────────────

async function sendResultsEmail(env, to, score, cost) {
	const html = buildResultsHtml(score, cost);

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: 'Scanner Rete Vendita <scanner@keryxdesign.com>',
			to: [to],
			subject: `Il tuo Indice di Rischio Dipendenza: ${score}/100`,
			html,
		}),
	});

	if (!res.ok) return { ok: false, error: await res.text() };
	return { ok: true };
}

// ── Notification email to owner ────────────────────────────

const QUESTIONS = [
	'', // Q0 placeholder
	'Quanti venditori hai nella tua rete?',
	'Quanti ne hai persi o sostituiti negli ultimi 24 mesi?',
	'Quanto tempo ci mette un venditore nuovo a raggiungere il regime?',
	'Se domani il tuo miglior venditore se ne andasse, che % di fatturato perderesti?',
	'Quante ore/settimana dedichi TU a seguire clienti o trattative dei venditori?',
	'Quando un venditore perde un cliente importante, cosa succede?',
	'Differenza di fatturato tra il miglior e il peggior venditore?',
	'Quanti venditori nuovi NON hanno reso come ti aspettavi?',
	'I tuoi venditori vendono tutti allo stesso modo?',
	'Se tu sparissi per un mese, le vendite...',
];

async function sendNotifyEmail(env, userEmail, score, cost, answers) {
	const now = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

	let answersHtml = '';
	if (answers) {
		if (answers.venditori) {
			answersHtml += `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">Q1: ${QUESTIONS[1]}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;font-size:13px;">${answers.venditori} venditori</td></tr>`;
		}
		for (let i = 2; i <= 10; i++) {
			const val = answers['q' + i];
			if (val) {
				answersHtml += `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#666;font-size:13px;">Q${i}: ${QUESTIONS[i]}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;font-size:13px;">${val}</td></tr>`;
			}
		}
	}

	const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;"><tr><td align="center" style="padding:30px 20px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden;">

<tr><td style="padding:24px 24px 16px;border-bottom:1px solid #e5e7eb;">
<h1 style="color:#111827;font-size:18px;font-weight:700;margin:0 0 4px;">Nuovo lead da Scanner Rete Vendita</h1>
<p style="color:#6b7280;font-size:13px;margin:0;">${now}</p>
</td></tr>

<tr><td style="padding:20px 24px;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td style="padding:12px 16px;background:#f0f9ff;border-radius:8px;text-align:center;width:50%;">
<p style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px;">Score</p>
<p style="color:#0ea5e9;font-size:28px;font-weight:700;margin:0;">${score}/100</p>
</td>
<td style="width:12px;"></td>
<td style="padding:12px 16px;background:#f0fdf4;border-radius:8px;text-align:center;width:50%;">
<p style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px;">Costo stimato</p>
<p style="color:#16a34a;font-size:28px;font-weight:700;margin:0;">${cost}</p>
</td>
</tr>
</table>
</td></tr>

<tr><td style="padding:0 24px 20px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
<tr><td style="padding:12px;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;">Contatto</td><td style="padding:12px;font-size:13px;border-bottom:1px solid #e5e7eb;"><a href="mailto:${userEmail}" style="color:#0ea5e9;text-decoration:none;">${userEmail}</a></td></tr>
</table>
</td></tr>

${answersHtml ? `<tr><td style="padding:0 24px 20px;">
<p style="color:#374151;font-size:13px;font-weight:600;margin:0 0 8px;">Risposte complete</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
${answersHtml}
</table>
</td></tr>` : ''}

<tr><td style="padding:16px 24px;background:#f9fafb;text-align:center;">
<a href="mailto:${userEmail}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Rispondi al lead</a>
</td></tr>

</table>
</td></tr></table>
</body></html>`;

	const notifyTo = (env.NOTIFY_EMAIL || 'info@keryxdesign.com').split(',').map(e => e.trim());

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: 'Scanner Pusca <scanner@keryxdesign.com>',
			to: notifyTo,
			subject: `[Scanner] ${userEmail} - Score ${score}/100 - ${cost}`,
			html,
		}),
	});

	if (!res.ok) return { ok: false, error: await res.text() };
	return { ok: true };
}

// ── Results email HTML (with LORI corrections) ─────────────

function buildResultsHtml(score, cost) {
	const scoreColor = Number(score) >= 60 ? '#ef4444' : Number(score) >= 35 ? '#f59e0b' : '#22c55e';
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;"><tr><td align="center" style="padding:40px 20px;">
<table width="600" cellpadding="0" cellspacing="0" style="background:#0c1220;border-radius:16px;overflow:hidden;">

<!-- Header -->
<tr><td style="padding:40px 24px 20px;text-align:center;">
<h1 style="color:#fff;font-size:24px;font-weight:700;margin:0 0 8px;">Scanner Rete Vendita</h1>
<p style="color:rgba(255,255,255,0.5);font-size:14px;margin:0;">I tuoi risultati personali</p>
</td></tr>

<!-- Score -->
<tr><td style="padding:0 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2);border-radius:12px;">
<tr><td style="padding:24px;text-align:center;">
<p style="color:rgba(255,255,255,0.6);font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">Indice di Rischio Dipendenza</p>
<p style="color:${scoreColor};font-size:48px;font-weight:700;margin:0;">${score}<span style="font-size:20px;color:rgba(255,255,255,0.4);">/100</span></p>
</td></tr></table>
</td></tr>

<!-- Cost -->
<tr><td style="padding:16px 24px 0;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:12px;">
<tr><td style="padding:24px;text-align:center;">
<p style="color:#4ade80;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;">Costo stimato annuo</p>
<p style="color:#22c55e;font-size:36px;font-weight:700;margin:0 0 12px;">${cost}</p>
<p style="color:rgba(255,255,255,0.4);font-size:12px;margin:0;line-height:1.5;">Include: turnover, ramp-up, tempo sottratto alla strategia, mancato fatturato da venditori sotto-performanti.</p>
</td></tr></table>
</td></tr>

<!-- Bridge -->
<tr><td style="padding:24px 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;">
<tr><td style="padding:20px 24px;">
<p style="color:#fff;font-size:16px;font-weight:500;margin:0 0 8px;">Il 70% di questo costo non dipende dalle tecniche di vendita.</p>
<p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0;line-height:1.6;">Dipende dal fatto che le persone nella tua rete non sono nel posto giusto. Il metodo BEDo parte da qui: profilazione comportamentale con strumenti brevettati e neuroscientifici.</p>
</td></tr></table>
</td></tr>

<!-- CTAs label -->
<tr><td style="padding:0 24px;">
<p style="color:rgba(255,255,255,0.5);font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin:0 0 16px;">Cosa puoi fare adesso</p>
</td></tr>

<!-- CTA 1: WhatsApp (primary button) -->
<tr><td style="padding:0 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;margin-bottom:12px;">
<tr><td style="padding:16px 20px;">
<p style="color:#fff;font-size:14px;font-weight:600;margin:0 0 4px;">1. Ne parliamo.</p>
<p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 12px;">Call di 20 minuti con Cristiano Pusca. Nessun impegno.</p>
<a href="https://wa.me/393408217120?text=Ciao%20Cristiano%2C%20ho%20fatto%20lo%20Scanner%20Rete%20Vendita%20e%20vorrei%20parlarne." style="display:inline-block;background:#25D366;color:#fff;padding:12px 24px;border-radius:10px;font-size:13px;font-weight:600;text-decoration:none;">Prenota 20 minuti su WhatsApp</a>
</td></tr></table>
</td></tr>

<!-- CTA 2: Assessment -->
<tr><td style="padding:0 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.2);border-radius:10px;margin-bottom:12px;">
<tr><td style="padding:16px 20px;">
<p style="color:#fff;font-size:14px;font-weight:600;margin:0 0 4px;">2. Prova lo strumento su di te.</p>
<p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 8px;">Assessment individuale con restituzione LIVE. 750 EUR.</p>
<a href="https://wa.me/393408217120?text=Ciao%20Cristiano%2C%20vorrei%20provare%20l%27assessment%20individuale%20da%20750%20EUR." style="color:#0ea5e9;font-size:13px;font-weight:600;text-decoration:none;">Richiedi l'assessment &rarr;</a>
</td></tr></table>
</td></tr>

<!-- CTA 3: Pacchetti -->
<tr><td style="padding:0 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:10px;margin-bottom:12px;">
<tr><td style="padding:16px 20px;">
<p style="color:#fff;font-size:14px;font-weight:600;margin:0 0 4px;">3. Parti con il team.</p>
<p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 8px;">Scegli il pacchetto per la tua rete vendita.</p>
<a href="https://cristianopusca.it/#pacchetti" style="color:#22c55e;font-size:13px;font-weight:600;text-decoration:none;">Vedi i pacchetti &rarr;</a>
</td></tr></table>
</td></tr>

<!-- Footer -->
<tr><td style="padding:24px 24px 40px;text-align:center;">
<p style="color:rgba(255,255,255,0.35);font-size:11px;margin:0;">Cristiano Pusca &middot; Metodo BEDo &middot; Human Value First</p>
<p style="color:rgba(255,255,255,0.3);font-size:10px;margin:8px 0 0;">Hai ricevuto questa email perche' hai completato lo Scanner Rete Vendita su cristianopusca.it</p>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// ── Utilities ──────────────────────────────────────────────

async function md5(text) {
	const data = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest('MD5', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function corsHeaders(env, request) {
	const origin = request?.headers?.get('Origin') || '';
	const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim());
	const match = allowed.includes(origin) ? origin : allowed[0] || '*';
	return {
		'Access-Control-Allow-Origin': match,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
}

function jsonResponse(data, status, env, request) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...corsHeaders(env, request) },
	});
}
