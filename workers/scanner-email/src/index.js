export default {
	async fetch(request, env) {
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders(env, request) });
		}

		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed' }, 405, env, request);
		}

		// Route by URL pathname
		const url = new URL(request.url);
		const path = url.pathname.replace(/\/+$/, '');

		try {
			if (path.endsWith('/assessment')) {
				return await handleAssessment(request, env);
			}
			// Default: scanner rete vendita (back-compat con flow esistente)
			return await handleScanner(request, env);
		} catch (err) {
			console.error('Worker error:', err);
			return jsonResponse({ error: 'Internal error' }, 500, env, request);
		}
	},
};

// ── Handler: SCANNER RETE VENDITA (esistente) ──────────────

async function handleScanner(request, env) {
	const { firstName, lastName, email, settore, score, cost, newsletter, answers } = await request.json();

	if (!email || score == null || !cost) {
		return jsonResponse({ error: 'Missing required fields' }, 400, env, request);
	}

	const mcResult = await addToMailchimp(env, email, firstName, lastName, settore, score, cost, newsletter);
	if (!mcResult.ok) console.error('Mailchimp error (non-blocking):', mcResult.error);

	const emailResult = await sendResultsEmail(env, email, firstName);
	if (!emailResult.ok) console.error('Resend user email error:', emailResult.error);

	const notifyResult = await sendNotifyEmail(env, email, firstName, lastName, settore, score, cost, answers);
	if (!notifyResult.ok) console.error('Resend notify error:', notifyResult.error);

	return jsonResponse({ success: true, mailchimp: mcResult.ok }, 200, env, request);
}

// ── Handler: ASSESSMENT COMPORTAMENTALE (nuovo lead magnet) ─

async function handleAssessment(request, env) {
	const { firstName, email, consent_assessment, consent_newsletter } = await request.json();

	if (!email || !consent_assessment) {
		return jsonResponse({ error: 'Email e consenso al trattamento dati sono obbligatori' }, 400, env, request);
	}

	// Email format basic check
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return jsonResponse({ error: 'Email non valida' }, 400, env, request);
	}

	// 1. Mailchimp subscribe + tags
	const mcResult = await addAssessmentLead(env, email, firstName, consent_newsletter);
	if (!mcResult.ok) {
		console.error('Mailchimp assessment error (non-blocking):', mcResult.error);
	}

	// 2. Welcome email via Resend (immediata)
	const welcomeResult = await sendAssessmentWelcome(env, email, firstName);
	if (!welcomeResult.ok) {
		console.error('Resend assessment welcome error:', welcomeResult.error);
		return jsonResponse({ error: 'Errore invio mail. Riprova o scrivi a info@cristianopusca.com' }, 502, env, request);
	}

	// 3. Notify owner
	const notifyResult = await sendAssessmentNotify(env, email, firstName, consent_newsletter);
	if (!notifyResult.ok) console.error('Resend assessment notify error:', notifyResult.error);

	return jsonResponse({ success: true, redirect: '/assessment-comportamentale/esempio' }, 200, env, request);
}

async function addAssessmentLead(env, email, firstName, consent_newsletter) {
	const server = env.MAILCHIMP_SERVER;
	const listId = env.MAILCHIMP_LIST_ID;
	const apiKey = env.MAILCHIMP_API_KEY;
	const authHeader = `Basic ${btoa('anystring:' + apiKey)}`;
	const emailHash = await md5(email.toLowerCase());
	const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${emailHash}`;

	const merge_fields = {};
	if (firstName) merge_fields.FNAME = firstName;

	// PUT = create-or-update. status 'subscribed' = SOI (DOI è già disabilitato sulla lista).
	const res = await fetch(url, {
		method: 'PUT',
		headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email_address: email,
			status_if_new: 'subscribed',
			merge_fields,
		}),
	});

	if (!res.ok) {
		const body = await res.json();
		return { ok: false, error: body.detail || body.title };
	}

	const tags = [{ name: 'assessment-comportamentale', status: 'active' }];
	if (consent_newsletter) tags.push({ name: 'newsletter-optin', status: 'active' });

	await fetch(`https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${emailHash}/tags`, {
		method: 'POST',
		headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
		body: JSON.stringify({ tags }),
	});

	return { ok: true };
}

async function sendAssessmentWelcome(env, to, firstName) {
	const html = buildAssessmentWelcomeHtml(firstName);
	const greeting = firstName ? `${firstName}, ` : '';

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			// DKIM Resend cristianopusca.com verificato (record DNS aggiunti 20 mag 2026).
			from: 'Cristiano Pusca <info@cristianopusca.com>',
			to: [to],
			reply_to: 'cristiano@be-do.it',
			subject: `L'esempio dell'assessment, come promesso`,
			html,
		}),
	});

	if (!res.ok) return { ok: false, error: await res.text() };
	return { ok: true };
}

async function sendAssessmentNotify(env, userEmail, firstName, consent_newsletter) {
	const now = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
	const name = firstName || '(non fornito)';
	const newsletterFlag = consent_newsletter ? 'Sì' : 'No';

	const html = `<!DOCTYPE html><html><body style="margin:0;padding:30px;background:#f9fafb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="600" cellpadding="0" cellspacing="0" align="center" style="background:#fff;border-radius:12px;border:1px solid #e5e7eb;">
<tr><td style="padding:24px;">
<h1 style="color:#111827;font-size:18px;margin:0 0 4px;">Nuovo lead Assessment Comportamentale</h1>
<p style="color:#6b7280;font-size:13px;margin:0 0 20px;">${now}</p>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
<tr><td style="padding:12px;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;width:160px;">Nome</td><td style="padding:12px;font-size:13px;border-bottom:1px solid #e5e7eb;">${name}</td></tr>
<tr><td style="padding:12px;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;">Email</td><td style="padding:12px;font-size:13px;border-bottom:1px solid #e5e7eb;"><a href="mailto:${userEmail}" style="color:#0ea5e9;text-decoration:none;">${userEmail}</a></td></tr>
<tr><td style="padding:12px;font-size:13px;font-weight:600;color:#374151;">Newsletter</td><td style="padding:12px;font-size:13px;">${newsletterFlag}</td></tr>
</table>
<p style="margin:20px 0 0;text-align:center;"><a href="mailto:${userEmail}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Rispondi al lead</a></p>
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
			from: 'Cristiano Pusca <notify@keryxdesign.com>',
			to: notifyTo,
			subject: `[Assessment] Nuovo lead: ${name} <${userEmail}>`,
			html,
		}),
	});

	if (!res.ok) return { ok: false, error: await res.text() };
	return { ok: true };
}

function buildAssessmentWelcomeHtml(firstName) {
	const greeting = firstName ? `Ciao ${firstName},` : 'Ciao,';
	const reportUrl = 'https://cristianopusca.com/esempio-report';
	const P = 'font-size:16px;line-height:1.6;margin:0 0 16px 0;color:#1A1A1A;font-family:Georgia,serif;';
	return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>L'esempio dell'assessment, come promesso</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;">
<div style="display:none;font-size:1px;color:#f4f4f4;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Dodici pagine, ogni paragrafo commentato. Leggilo con calma, non come un oroscopo.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;"><tr><td align="center" style="padding:36px 14px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;">
<tr><td style="padding:44px 36px 36px 36px;">

<p style="font-size:18px;line-height:1.55;margin:0 0 18px 0;color:#1A1A1A;font-family:Georgia,serif;">${greeting}</p>

<p style="${P}">Eccolo, come promesso.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0;"><tr><td style="background:#B8382B;">
<a href="${reportUrl}" style="display:inline-block;padding:14px 30px;font-family:Lexend,Arial,Helvetica,sans-serif;font-weight:700;font-size:17px;color:#ffffff;text-decoration:none;">Apri l'esempio di assessment</a>
</td></tr></table>

<p style="${P}">È l'assessment comportamentale che ho fatto <strong>su me stesso</strong>. Dodici pagine, e accanto a ogni paragrafo il mio commento: <em>cosa vuol dire nella pratica, e cosa farei diversamente</em>.</p>

<p style="${P}">Non è un test su di te. È un esempio, e serve a una cosa sola: <strong>farti vedere che tipo di informazioni tira fuori uno strumento così</strong> su una persona vera. Le leggi con lo stesso occhio con cui le guardo io quando le discuto con un imprenditore.</p>

<p style="${P}">Se mentre lo leggi ti viene in mente <strong>la faccia di un tuo venditore</strong>, o vuoi capire come si applica a una posizione precisa della tua rete, rispondi a questa mail. Ti rispondo <em>io</em>, di persona. Non è un indirizzo di sistema.</p>

<table role="presentation" cellpadding="0" cellspacing="0" style="margin:34px 0 0 0;border-collapse:collapse;"><tr>
<td style="vertical-align:middle;padding-right:14px;width:60px;">
<img src="https://mcusercontent.com/d327453d6178f9f8dfe810d6f/images/45216a28-af41-c024-0d7b-22b263a7de4b.jpg" width="58" height="58" alt="Cristiano Pusca" style="display:block;width:58px;height:58px;border-radius:50%;">
</td>
<td style="vertical-align:middle;">
<span style="font-family:Georgia,serif;font-style:italic;font-weight:700;font-size:18px;color:#1A1A1A;">Cristiano Pusca</span><br>
<span style="font-family:Lexend,Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;color:#595959;">Aiuto le PMI a costruire una rete vendita che cammina senza dipendere dal titolare</span>
</td></tr></table>

<div style="font-size:12px;color:#6B6B6B;line-height:1.5;padding:26px 0 0 0;margin-top:28px;border-top:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">
&copy; ${new Date().getFullYear()} Cristiano Pusca &middot; BPDA S.R.L. &middot; Vicolo XX Settembre 11, 31100 Treviso (TV) &middot; P.IVA 04993860263<br><br>
Hai ricevuto questa mail perché hai richiesto l'esempio di assessment su cristianopusca.com.<br>
<a href="https://cristianopusca.com/privacy" style="color:#6B6B6B;">Privacy Policy</a> &middot; <a href="https://us13.list-manage.com/unsubscribe?u=d327453d6178f9f8dfe810d6f&id=2a69d16d64" style="color:#6B6B6B;">Cancella iscrizione</a>
</div>

</td></tr></table>
</td></tr></table>
</body>
</html>`;
}

// ── Mailchimp ──────────────────────────────────────────────

async function addToMailchimp(env, email, firstName, lastName, settore, score, cost, newsletter) {
	const server = env.MAILCHIMP_SERVER;
	const listId = env.MAILCHIMP_LIST_ID;
	const apiKey = env.MAILCHIMP_API_KEY;
	const authHeader = `Basic ${btoa('anystring:' + apiKey)}`;
	const emailHash = await md5(email.toLowerCase());
	const url = `https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${emailHash}`;

	const merge_fields = { SCORE: String(score), COSTO: String(cost) };
	if (firstName) merge_fields.FNAME = firstName;
	if (lastName) merge_fields.LNAME = lastName;
	if (settore) merge_fields.SETTORE = settore;

	const res = await fetch(url, {
		method: 'PUT',
		headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email_address: email,
			status_if_new: newsletter ? 'subscribed' : 'transactional',
			merge_fields,
		}),
	});

	if (!res.ok) {
		const body = await res.json();
		return { ok: false, error: body.detail || body.title };
	}

	const tags = [{ name: 'scanner-done', status: 'active' }];
	if (newsletter) tags.push({ name: 'newsletter-optin', status: 'active' });

	await fetch(`https://${server}.api.mailchimp.com/3.0/lists/${listId}/members/${emailHash}/tags`, {
		method: 'POST',
		headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
		body: JSON.stringify({ tags }),
	});

	return { ok: true };
}

// ── Results email to user ──────────────────────────────────

function buildScannerEmailHtml(firstName) {
	const greeting = firstName ? `Ciao ${firstName},` : 'Ciao,';
	const P = 'font-family:Georgia,serif;font-size:17px;line-height:27px;color:#1A1A1A;-webkit-text-fill-color:#1A1A1A;margin:0 0 16px 0;';
	return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Quello che il numero non ti ha ancora detto</title>
<style>:root,body{color-scheme:light;supported-color-schemes:light;}</style>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;color-scheme:light;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#ffffff;font-size:1px;line-height:1px;">Dodici pagine. Il mio assessment, quello da cui è partito tutto. Senza giri.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;"><tr><td align="center" style="padding:28px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;width:100%;background-color:#ffffff;">
<tr><td style="padding:24px 30px 36px 30px;">

<p style="font-family:Georgia,serif;font-size:18px;line-height:28px;color:#1A1A1A;-webkit-text-fill-color:#1A1A1A;margin:0 0 18px 0;">${greeting}</p>

<p style="${P}">hai appena visto il tuo numero.</p>

<p style="${P}">Non te lo ripeto. Lo hai già davanti, e probabilmente ti ha dato fastidio per il motivo giusto: <strong>conferma una cosa che sapevi già ma che nessuno aveva ancora messo in cifra.</strong></p>

<p style="${P}">Quel numero ti dice <em>quanto</em> dipendi dalla tua rete vendita. Non ti dice <strong>perché.</strong></p>

<p style="${P}">E il perché non sta nei fatturati. Sta nelle persone che hai in squadra. In <em>chi</em> sono, non in quanto vendono.</p>

<p style="${P}">Tu i tuoi numeri li conosci. Sai chi è sotto target e chi tiene. Quello che non vedi è come lavora davvero ognuno quando tu non sei in macchina con lui. Non perché non guardi. <strong>Perché non è una cosa che si guarda a occhio. Si misura.</strong></p>

<p style="font-family:Lexend,Arial,sans-serif;font-size:19px;line-height:26px;font-weight:700;color:#1A1A1A;-webkit-text-fill-color:#1A1A1A;margin:30px 0 12px 0;">Te lo faccio vedere su di me</p>

<p style="${P}">L'assessment comportamentale che ho fatto <strong>su me stesso</strong>. Dodici pagine, ogni paragrafo col mio commento a margine: come decido, dove vado forte, dove mi costa fatica.</p>

<p style="${P}">Non è un documento qualunque. È lo strumento che mi ha cambiato la vita: da quando ho capito chi ero davvero, <strong>ho guidato una rete di cento commerciali e contribuito a portare l'azienda per cui lavoravo oltre i cento milioni di fatturato.</strong> Non è il tuo, è il mio. Ma è la stessa foto che manca quando una rete vendita dipende ancora dal titolare. Si parte sempre da una persona sola, anche se oggi ne hai cinque.</p>

<p style="${P}">Guardalo con calma. Bastano cinque minuti.</p>

<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:30px auto 6px auto;"><tr>
<td align="center" bgcolor="#B8382B" style="border-radius:8px;background-color:#B8382B;">
<a href="https://cristianopusca.com/esempio-report" target="_blank" style="display:inline-block;padding:18px 42px;font-family:Lexend,Arial,sans-serif;font-size:18px;line-height:18px;font-weight:700;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;text-decoration:none;border-radius:8px;">Apri l'esempio di assessment</a>
</td></tr></table>
<p style="font-family:Arial,sans-serif;font-size:13px;line-height:20px;color:#6B6B6B;text-align:center;margin:0 0 30px 0;">Oppure apri: <a href="https://cristianopusca.com/esempio-report" style="color:#B8382B;text-decoration:underline;">cristianopusca.com/esempio-report</a></p>

<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin-top:6px;"><tr>
<td width="56" valign="top" style="padding-right:14px;">
<img src="https://mcusercontent.com/d327453d6178f9f8dfe810d6f/images/45216a28-af41-c024-0d7b-22b263a7de4b.jpg" width="56" height="56" alt="Cristiano Pusca" style="display:block;width:56px;height:56px;border-radius:28px;border:0;outline:none;">
</td>
<td valign="middle">
<div style="font-family:Lexend,Arial,sans-serif;font-size:16px;font-weight:600;color:#1A1A1A;line-height:22px;">Cristiano Pusca</div>
<div style="font-family:Georgia,serif;font-size:14px;line-height:20px;color:#6B6B6B;">Aiuto le PMI a costruire una rete vendita che cammina senza dipendere dal titolare</div>
</td></tr></table>

<div style="font-family:Arial,sans-serif;font-size:12px;line-height:18px;color:#9A9A9A;padding-top:26px;margin-top:28px;border-top:1px solid #eeeeee;">
&copy; ${new Date().getFullYear()} Cristiano Pusca &middot; BPDA S.R.L. &middot; Vicolo XX Settembre 11, 31100 Treviso (TV) &middot; P.IVA 04993860263<br><br>
Hai ricevuto questa mail perché hai fatto il test "Misura la rete vendita" su cristianopusca.com. &middot; <a href="https://us13.list-manage.com/unsubscribe?u=d327453d6178f9f8dfe810d6f&id=2a69d16d64" style="color:#9A9A9A;">Cancella iscrizione</a>
</div>

</td></tr></table>
</td></tr></table>
</body>
</html>`;
}

async function sendResultsEmail(env, to, firstName) {
	const html = buildScannerEmailHtml(firstName);

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: 'Cristiano Pusca <info@cristianopusca.com>',
			to: [to],
			reply_to: 'cristiano@be-do.it',
			subject: 'Quello che il numero non ti ha ancora detto',
			html,
		}),
	});

	if (!res.ok) return { ok: false, error: await res.text() };
	return { ok: true };
}

// ── Notification email to owner ────────────────────────────

const QUESTIONS = [
	'', // Q0 placeholder
	'Quanti venditori o agenti hai nella rete?',
	'Quante ore a settimana passi ancora tu dentro le vendite?',
	'Con chi parlano davvero i clienti più importanti?',
	'Se sparissi per un mese, le vendite...',
	'Quando non ci sei, le decisioni commerciali...',
	'Su cosa ti basi quando assumi un commerciale?',
	'Hai venditori che mancano il budget da oltre un anno e non hai spostato?',
	'Quanto ci mette un venditore nuovo ad arrivare a regime?',
	'Quanti venditori persi o sostituiti negli ultimi 12 mesi?',
	'In che fascia di fatturato sei?',
];

async function sendNotifyEmail(env, userEmail, firstName, lastName, settore, score, cost, answers) {
	const now = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
	const fullName = [firstName, lastName].filter(Boolean).join(' ') || '(non fornito)';
	const settoreLabel = settore || '(non fornito)';

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

	const sNum = Number(score) || 0;
	const fascia = sNum >= 76 ? 'CRITICA' : sNum >= 51 ? 'ALTA' : sNum >= 26 ? 'MODERATA' : 'BASSA';
	const fColor = sNum >= 76 ? '#dc2626' : sNum >= 51 ? '#ea580c' : sNum >= 26 ? '#ca8a04' : '#16a34a';
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
<td style="padding:12px 16px;background:#f9fafb;border-radius:8px;text-align:center;width:50%;border:1px solid #e5e7eb;">
<p style="color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px;">Indice di Dipendenza</p>
<p style="color:${fColor};font-size:28px;font-weight:700;margin:0;">${score}/100</p>
<p style="color:${fColor};font-size:12px;font-weight:700;letter-spacing:0.5px;margin:4px 0 0;">DIPENDENZA ${fascia}</p>
<p style="color:#9ca3af;font-size:10px;margin:3px 0 0;">più alto = più dipendente da te</p>
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
<tr><td style="padding:12px;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;width:120px;">Nome</td><td style="padding:12px;font-size:13px;border-bottom:1px solid #e5e7eb;font-weight:600;">${fullName}</td></tr>
<tr><td style="padding:12px;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;">Settore</td><td style="padding:12px;font-size:13px;border-bottom:1px solid #e5e7eb;">${settoreLabel}</td></tr>
<tr><td style="padding:12px;font-size:13px;font-weight:600;color:#374151;border-bottom:1px solid #e5e7eb;">Email</td><td style="padding:12px;font-size:13px;border-bottom:1px solid #e5e7eb;"><a href="mailto:${userEmail}" style="color:#0ea5e9;text-decoration:none;">${userEmail}</a></td></tr>
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
			subject: `[Scanner] ${fullName} (${settoreLabel}) - Score ${score}/100 - ${cost}`,
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
<p style="color:rgba(255,255,255,0.5);font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin:0 0 16px;">Il passo successivo</p>
</td></tr>

<!-- CTA 1: WhatsApp (primary) -->
<tr><td style="padding:0 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;margin-bottom:12px;">
<tr><td style="padding:16px 20px;">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="width:32px;vertical-align:top;"><p style="color:rgba(255,255,255,0.2);font-size:24px;font-weight:700;margin:0;">1</p></td>
<td style="padding-left:12px;">
<p style="color:#fff;font-size:14px;font-weight:600;margin:0 0 4px;">Guardiamo i tuoi numeri insieme.</p>
<p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 12px;">20 minuti con Cristiano. Nessun impegno, nessuna presentazione. Solo i tuoi dati, letti da chi sa cosa cercare.</p>
<a href="https://wa.me/393408217120?text=Ciao%20Cristiano%2C%20ho%20fatto%20lo%20Scanner%20Rete%20Vendita%20e%20vorrei%20parlarne." style="display:inline-block;background:#25D366;color:#fff;padding:12px 24px;border-radius:10px;font-size:13px;font-weight:600;text-decoration:none;">Prenota 20 minuti</a>
</td>
</tr></table>
</td></tr></table>
</td></tr>

<!-- CTA 2: Assessment demo -->
<tr><td style="padding:0 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(14,165,233,0.08);border:1px solid rgba(14,165,233,0.15);border-radius:10px;margin-bottom:12px;">
<tr><td style="padding:16px 20px;">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="width:32px;vertical-align:top;"><p style="color:rgba(255,255,255,0.2);font-size:24px;font-weight:700;margin:0;">2</p></td>
<td style="padding-left:12px;">
<p style="color:#fff;font-size:14px;font-weight:600;margin:0 0 4px;">Vedi lo strumento in azione.</p>
<p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 8px;">Assessment demo su di te: provi lo stesso strumento che poi usi sulla rete. Restituzione LIVE, vedi subito come funziona. 750 EUR.</p>
<a href="https://wa.me/393408217120?text=Ciao%20Cristiano%2C%20ho%20fatto%20lo%20Scanner%20e%20vorrei%20fare%20l%27assessment%20demo%20da%20750%20EUR." style="color:#0ea5e9;font-size:13px;font-weight:600;text-decoration:none;">Richiedi la demo &rarr;</a>
</td>
</tr></table>
</td></tr></table>
</td></tr>

<!-- CTA 3: Pacchetti -->
<tr><td style="padding:0 24px;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.15);border-radius:10px;margin-bottom:12px;">
<tr><td style="padding:16px 20px;">
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="width:32px;vertical-align:top;"><p style="color:rgba(255,255,255,0.2);font-size:24px;font-weight:700;margin:0;">3</p></td>
<td style="padding-left:12px;">
<p style="color:#fff;font-size:14px;font-weight:600;margin:0 0 4px;">Parti direttamente con il team.</p>
<p style="color:rgba(255,255,255,0.5);font-size:13px;margin:0 0 8px;">Sai gia' come funziona e vuoi applicarlo alla rete vendita.</p>
<a href="https://cristianopusca.com/#pacchetti" style="color:#22c55e;font-size:13px;font-weight:600;text-decoration:none;">Vedi i pacchetti &rarr;</a>
</td>
</tr></table>
</td></tr></table>
</td></tr>

<!-- Footer -->
<tr><td style="padding:24px 24px 40px;text-align:center;">
<p style="color:rgba(255,255,255,0.35);font-size:11px;margin:0;">Cristiano Pusca &middot; Metodo BEDo &middot; Human Value First</p>
<p style="color:rgba(255,255,255,0.3);font-size:10px;margin:8px 0 0;">Hai ricevuto questa email perche' hai completato lo Scanner Rete Vendita su <a href="https://cristianopusca.com/scanner" style="color:rgba(255,255,255,0.4);">cristianopusca.com</a></p>
<p style="margin:12px 0 0;"><a href="https://us13.list-manage.com/unsubscribe?u=d327453d6178f9f8dfe810d6f&id=2a69d16d64" style="color:rgba(255,255,255,0.3);font-size:10px;text-decoration:underline;">Cancella iscrizione</a></p>
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
