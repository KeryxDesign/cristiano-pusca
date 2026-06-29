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
	const { firstName, lastName, email, settore, score, cost, newsletter, answers, vals, venditori, fatturatoVal } = await request.json();

	if (!email || score == null || !cost) {
		return jsonResponse({ error: 'Missing required fields' }, 400, env, request);
	}

	const mcResult = await addToMailchimp(env, email, firstName, lastName, settore, score, cost, newsletter);
	if (!mcResult.ok) console.error('Mailchimp error (non-blocking):', mcResult.error);

	const emailResult = await sendResultsEmail(env, email, firstName, { score, vals, venditori, fatturatoVal });
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

// ── Results email to user: IL GIUDIZIO per fascia ──────────

// fascia dallo score (stessa logica della notify)
function fasciaFromScore(score) {
	const s = Number(score) || 0;
	return s >= 76 ? 'CRITICA' : s >= 51 ? 'ALTA' : s >= 26 ? 'MODERATA' : 'BASSA';
}

// `*corsivo*` → <em>
function emph(s) {
	return s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// helper accesso ai valori grezzi 0-3 delle risposte
function v(vals, n) {
	const x = vals && vals['q' + n];
	return typeof x === 'number' ? x : (parseInt(x) || 0);
}

// Le 8 righe-innesto. Ogni voce: id, priorità (più basso = prima), test, testo.
// Priorità copy: I2 > I1 > I5 > I3 > I4 > I6. Modulatori I7/I8 in coda. I6 esclude I4.
function buildInnesti(vals, venditori, fatturatoVal, score, fasciaAlta) {
	const N = Number(venditori) || 0;
	const F = Number(fatturatoVal) || 0;
	const all = [
		{ id: 'I2', prio: 1, on: v(vals, 2) === 3 && v(vals, 3) >= 2,
			text: 'Sulla carta hai una rete. Di fatto la rete sei tu. Non lo dico io, è quello che hai appena risposto: più di dieci ore a settimana dentro le vendite, e i clienti che contano che vogliono te al telefono, non il loro venditore.' },
		{ id: 'I1', prio: 2, on: v(vals, 9) >= 2 && v(vals, 8) >= 2,
			text: 'Hai perso più di un venditore quest\'anno, e chi entra ci mette mesi a carburare. Non è sfortuna, e non è che peschi male. Fai entrare gente nuova nello stesso buco, senza aver mai cambiato il buco. Cambi la persona, lasci la struttura. E la struttura li mangia uno dopo l\'altro.' },
		{ id: 'I5', prio: 3, on: v(vals, 4) >= 2 && v(vals, 5) >= 2,
			text: 'Se sparisci, le vendite calano e le decisioni si fermano ad aspettarti. Non hai costruito una rete. Hai costruito un riflesso: tutti aspettano te. E ogni volta che rispondi tu, quel riflesso si rinforza. Più sei bravo a coprire, più li alleni ad aspettarti.' },
		{ id: 'I3', prio: 4, on: v(vals, 7) >= 2,
			text: 'C\'è uno che non rende e lo tieni lì "perché tanto...". Quel "perché tanto" lo sai finire da solo. Lo tieni perché sostituirlo è una grana che già conosci, mentre il rischio di lasciarlo è un rischio che non hai mai messo in numeri. Fai un calcolo a sensazione, e a sensazione la grana certa pesa sempre più del costo che non vedi. Solo che quel costo lo paghi ogni mese, uguale.' },
		{ id: 'I4', prio: 5, on: v(vals, 6) === 3,
			text: 'Scegli i commerciali a naso, e l\'hai scritto tu: spesso hai sbagliato. Il problema non è che sei sfortunato con le persone. È il modo in cui le scegli. La pancia ci azzecca a volte. Guardare i numeri della persona, prima di assumerla, ci azzecca quasi sempre.' },
		{ id: 'I6', prio: 6, on: v(vals, 6) <= 1 && v(vals, 2) >= 2 && v(vals, 3) >= 2,
			text: 'Un metodo ce l\'hai. Non improvvisi, selezioni con criterio, hai degli strumenti. Eppure sei ancora dentro le trattative, e i clienti grossi continuano a cercare te. Non ti manca la teoria, quella la conosci meglio di tanti. Ti manca l\'ultimo pezzo: quello che traduce ciò che sai nei comportamenti di chi vende al posto tuo. Sapere come si fa e farlo fare ad altri sono due lavori diversi.' },
	];

	// I6 mutuamente esclusivo con I4: se I6 acceso, spegni I4
	const i6on = all.find(x => x.id === 'I6').on;
	if (i6on) all.find(x => x.id === 'I4').on = false;

	// accesi, ordinati per priorità, cap 2
	let picked = all.filter(x => x.on).sort((a, b) => a.prio - b.prio).slice(0, 2);

	// modulatori I7/I8 in coda (solo se indice alto). Contano nel cap a 3.
	const mods = [];
	if (fasciaAlta && N >= 6) {
		mods.push({ id: 'I7', text: `E questo con ${N} persone in rete. Più gente passa da te, più il collo di bottiglia stringe: non si allarga aggiungendo teste, si stringe.` });
	}
	if (fasciaAlta && F >= 5000000) {
		mods.push({ id: 'I8', text: 'A questa fascia di fatturato, restare il primo commerciale non è un dettaglio. È il tappo che tiene ferma l\'azienda esattamente sulla soglia dove sei. Sopra non si sale finché il motore sei tu.' });
	}

	// cap totale 3 (2 innesti + eventuali modulatori, fino a 3 in tutto)
	const room = Math.max(0, 3 - picked.length);
	return picked.concat(mods.slice(0, room));
}

// FRAME del giudizio per fascia (testo MUSE). [N] = score reale.
// Ogni frame: { open: prima fotografia, body2: seconda parte, tail: coda strumento+gancio }
function judgmentFrame(fascia, scoreStr) {
	const N = scoreStr;
	if (fascia === 'BASSA') {
		return {
			open: [
				`Hai fatto ${N}. Numero basso, e non è scontato: vuol dire che la tua rete cammina davvero senza di te. È merito tuo, tienitelo.`,
			],
			body2: [
				`Una cosa sola, da tenere d'occhio, se ti va. Il numero ti dice *che* la rete cammina, non *perché*: la regge un sistema, o la reggono una o due persone brave? Sono due basse diverse, e si assomigliano fino al giorno in cui una di quelle persone non c'è più. Dal test non si vede quale delle due hai. Lo sai solo tu, guardando chi hai in squadra una a una.`,
				`E te lo dico onesto: con un numero così, oggi, di me non hai bisogno. Tienti l'avvertenza in tasca. Il giorno che il banco inizia a reggere su una testa sola e quella traballa, sai dove sono.`,
			],
			tail: null, // BASSA: niente coda strumento, niente gancio "qual è il cliente"
			soft: true,
		};
	}
	if (fascia === 'MODERATA') {
		return {
			open: [
				`Hai fatto ${N}. È la zona grigia, ed è la più scivolosa di tutte. Non perché sia grave. Perché non è abbastanza grave da costringerti a fare qualcosa. La rete funziona abbastanza. E "abbastanza" è esattamente la trappola: non funziona così male da spingerti a muoverti, non funziona così bene da scalare. Resta lì. Sei uscito dal motore a metà: su una parte dei clienti la rete gira da sola, su un'altra parte rientri ancora tu senza nemmeno accorgertene. Hai una o due persone che reggono e una o due che galleggiano, e sulle seconde non hai mai deciso niente. Le tieni lì in attesa che si sistemino da sole.`,
			],
			body2: [
				`Ecco la parte scomoda di questo numero: da solo non si muove. Resta uguale anno dopo anno, perché niente ti obbliga a toccarlo. Nessuna crisi, nessun crollo. Solo una rete che lascia soldi sul tavolo ogni mese, e tu lo sai che li lascia, ma non sai dove di preciso. Sai che c'è margine. Sai più o meno chi tira e chi no. Il problema è quel "più o meno": non basta a decidere niente. La zona grigia si chiude in un modo solo, quando smetti di andare a sensazione e inizi a guardare i numeri delle persone una per una.`,
			],
			tail: { line: `qual è il cliente che oggi non puoi mollare a nessuno. Da lì si capisce dove finisce il "più o meno" e dove iniziano i numeri veri.` },
			soft: false,
		};
	}
	if (fascia === 'ALTA') {
		return {
			open: [
				`Hai fatto ${N}. Non è un brutto numero, è onesto. E onesto vuol dire che ti dice una cosa che forse non vuoi sentirti dire: sei ancora tu il primo commerciale della tua azienda. E qui la parte scomoda: tu ci hai già provato a uscirne. Un direttore, un corso. E sei ancora qui.`,
			],
			body2: [
				`Non sei uno che non sa delegare. Sei uno che ha delegato a una struttura non pronta ed è rientrato a tappare. E ogni volta che rientri, la rete smette di provarci. Il problema l'hai già capito, lo sai dire meglio di me: "se mi fermo si ferma tutto, se non mi fermo non si sfonda". Lo ripeti da tre anni ed è identico. Averlo capito non l'ha cambiato. Non per scarsa volontà. Perché hai provato a cambiare le persone senza prima sapere chi avevi davanti.`,
			],
			tail: { line: `qual è il cliente che oggi non puoi mollare a nessuno. È spesso lì che si vede da dove parte tutto.` },
			soft: false,
		};
	}
	// CRITICA
	return {
		open: [
			`Hai fatto ${N}. Te lo dico dritto, senza girarci attorno: non hai una rete vendita. Hai persone che vendono quando le guidi tu. Tutto passa da te. I clienti, le decisioni, gli sconti, i casi difficili: ogni cosa torna sulla tua scrivania. E non ci sei finito per caso. Ci sei finito perché ogni volta era più veloce farlo tu che spiegarlo. Una volta, dieci, mille, fino a oggi. Adesso "farlo tu" è l'unico modo che la macchina conosce. Non perché tu sia incapace di mollare. Perché hai costruito senza accorgertene una cosa che funziona in un modo solo: col tuo motore acceso sopra.`,
		],
		body2: [
			`E qui c'è il punto che questo numero ti mette davanti. Non "se" un giorno non puoi. *Quando*. Una malattia, un funerale, una settimana in cui devi staccare per forza. Una rete con questo numero non ha un piano B. Ha te. E tu sei una persona, e a un certo punto una persona ha bisogno di fermarsi. Lo sai che così non regge, non te lo sto rivelando io. Saperlo non ha cambiato niente, e c'è un motivo preciso: per uscirne dovresti fermarti un attimo a costruire l'alternativa, e fermarti è esattamente la cosa che con questo numero non puoi fare. Troppo dentro per delegare, troppo preso a tenere su tutto per costruire il modo di non tenerlo su tu. È un cappio, e si stringe da solo.`,
		],
		tail: { line: `qual è il cliente che oggi non puoi mollare a nessuno. Di solito è la prima maglia da sciogliere.` },
		soft: false,
	};
}

function buildScannerEmailHtml(firstName, ctx) {
	const greeting = firstName ? `Ciao ${firstName},` : 'Ciao,';
	const P = 'font-family:Georgia,serif;font-size:17px;line-height:27px;color:#1A1A1A;-webkit-text-fill-color:#1A1A1A;margin:0 0 16px 0;';
	const Pquote = 'font-family:Georgia,serif;font-size:17px;line-height:27px;color:#1A1A1A;-webkit-text-fill-color:#1A1A1A;margin:0;';

	const score = ctx?.score;
	const scoreStr = String(Number(score) || 0);
	const fascia = fasciaFromScore(score);
	const frame = judgmentFrame(fascia, scoreStr);
	const fasciaAlta = fascia === 'ALTA' || fascia === 'CRITICA';
	const innesti = frame.soft ? [] : buildInnesti(ctx?.vals, ctx?.venditori, ctx?.fatturatoVal, score, fasciaAlta);

	const para = (s) => `<p style="${P}">${emph(s)}</p>`;

	// corpo: 1a fotografia → innesti → 2a parte
	let bodyHtml = frame.open.map(para).join('\n');
	if (innesti.length) bodyHtml += '\n' + innesti.map(x => para(x.text)).join('\n');
	bodyHtml += '\n' + frame.body2.map(para).join('\n');

	// coda strumento + gancio reply (omessa per BASSA)
	let tailHtml = '';
	if (frame.tail) {
		tailHtml = `
<p style="${P}">Da questo punto sono passato anch'io. Quello che mi ha tirato fuori non è stato lavorare di più, è stato smettere di indovinare chi avevo in squadra. Sotto, ti faccio vedere lo strumento con cui l'ho capito.</p>

<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0 8px 0;"><tr>
<td style="border-left:3px solid #B8382B;padding:4px 0 4px 18px;">
<p style="${Pquote}">C'è un punto che questo numero non può dirti: il <em>come</em> esci da qui dipende da chi hai davvero in rete, e il test la persona non la vede. Se vuoi, rispondi a questa mail con una riga sola: ${emph(frame.tail.line)}</p>
</td></tr></table>`;
		// TODO caso peer reale da Cristiano: qui andrà la riga [CASO PEER REALE] quando disponibile.
	}

	// prova secondaria in coda (l'esempio-assessment, non più protagonista) — non per BASSA
	let provaHtml = '';
	if (!frame.soft) {
		provaHtml = `
<p style="${P}">E qui sotto, se vuoi, lo strumento con cui questa lettura si fa sul serio: l'assessment comportamentale che ho fatto su me stesso, dodici pagine, ogni paragrafo col mio commento a margine.</p>

<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:18px auto 6px auto;"><tr>
<td align="center" bgcolor="#B8382B" style="border-radius:8px;background-color:#B8382B;">
<a href="https://cristianopusca.com/esempio-report" target="_blank" style="display:inline-block;padding:15px 36px;font-family:Lexend,Arial,sans-serif;font-size:16px;line-height:16px;font-weight:700;color:#FFFFFF;-webkit-text-fill-color:#FFFFFF;text-decoration:none;border-radius:8px;">Apri l'esempio di assessment</a>
</td></tr></table>
<p style="font-family:Arial,sans-serif;font-size:13px;line-height:20px;color:#6B6B6B;text-align:center;margin:0 0 28px 0;">Oppure apri: <a href="https://cristianopusca.com/esempio-report" style="color:#B8382B;text-decoration:underline;">cristianopusca.com/esempio-report</a></p>`;
	}

	return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>La lettura del tuo numero</title>
<style>:root,body{color-scheme:light;supported-color-schemes:light;}</style>
</head>
<body style="margin:0;padding:0;background-color:#ffffff;color-scheme:light;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#ffffff;font-size:1px;line-height:1px;">Il numero te l'ha dato il test. Qui c'è cosa vuol dire, letto sulle tue risposte.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;"><tr><td align="center" style="padding:28px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;width:100%;background-color:#ffffff;">
<tr><td style="padding:24px 30px 36px 30px;">

<p style="font-family:Georgia,serif;font-size:18px;line-height:28px;color:#1A1A1A;-webkit-text-fill-color:#1A1A1A;margin:0 0 18px 0;">${greeting}</p>

${bodyHtml}
${tailHtml}
${provaHtml}

<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin-top:30px;"><tr>
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

async function sendResultsEmail(env, to, firstName, ctx) {
	const html = buildScannerEmailHtml(firstName, ctx);
	const fascia = fasciaFromScore(ctx?.score);
	// subject: la BASSA è un'avvertenza tra pari, le altre una lettura
	const subject = fascia === 'BASSA' ? 'La lettura del tuo numero (e una cosa da tenere d\'occhio)' : 'La lettura del tuo numero';

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
			subject,
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

// ── Export per test logica (no impatto sul worker) ─────────
export { buildScannerEmailHtml, buildInnesti, judgmentFrame, fasciaFromScore };
