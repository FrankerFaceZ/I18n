'use strict';

// ============================================================================
// Post a merge report to a Discord webhook.
//
//   DISCORD_WEBHOOK=https://discord.com/api/webhooks/... \
//   node scripts/notify-discord.mjs extract/report.json [--always]
//
// Optional environment, all filled in by the GitHub workflow:
//   SOURCE_REPO / SOURCE_SHA   the repository and commit that was scanned
//   COMMIT_URL                 the commit this run made to the i18n repo
//   RUN_URL                    the workflow run, for logs and artifacts
//   WEBLATE_URL                project page link (default: FFZ Weblate)
//
// Without --always, nothing is posted when there is nothing to report.
// ============================================================================

import fs from 'fs';

const args = process.argv.slice(2);
const reportFile = args.find(a => !a.startsWith('--'));
const always = args.includes('--always');

if (!reportFile) {
	console.error('Usage: node scripts/notify-discord.mjs extract/report.json [--always]');
	process.exit(2);
}

const webhook = process.env.DISCORD_WEBHOOK;
if (!webhook) {
	console.log('DISCORD_WEBHOOK is not set; skipping notification.');
	process.exit(0);
}

const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const orphanTotal = Object.values(report.orphaned).reduce((a, b) => a + b.length, 0);
const errors = report.issues.filter(i => i.level === 'error').length;
const warnings = report.issues.filter(i => i.level === 'warn').length;
const noteworthy = report.added.length + report.changed.length + report.moved.length + orphanTotal + report.conflicts.length + errors;

if (!noteworthy && !always) {
	console.log('Nothing to report; skipping notification.');
	process.exit(0);
}

const WEBLATE = process.env.WEBLATE_URL || 'https://weblate.frankerfacez.com/projects/frankerfacez/';
const sourceRepo = process.env.SOURCE_REPO || (report.repo === 'core' ? 'FrankerFaceZ/FrankerFaceZ' : 'FrankerFaceZ/Add-Ons');
const sourceSha = process.env.SOURCE_SHA || '';

// Discord limits: 256 title, 4096 description, 1024 per field value, 25 fields, 6000 total.
function clip(text, max) {
	return text.length <= max ? text : text.slice(0, max - 2) + ' …';
}

function list(items, format, max = 1000) {
	const out = [];
	let used = 0;
	for (const item of items) {
		const line = format(item);
		if (used + line.length + 1 > max) {
			out.push(`… and ${items.length - out.length} more`);
			break;
		}
		out.push(line);
		used += line.length + 1;
	}
	return out.join('\n');
}

const code = s => '`' + String(s).replace(/`/g, 'ˋ') + '`';

const fields = [];

if (report.added.length)
	fields.push({ name: `Added (${report.added.length})`, value: list(report.added, a => `${code(a.key)} — ${clip(a.phrase.replace(/\s+/g, ' '), 60)}`) });

if (report.changed.length)
	fields.push({ name: `Changed English (${report.changed.length})`, value: list(report.changed, c => `${code(c.key)}\n  − ${clip(c.old.replace(/\s+/g, ' '), 50)}\n  + ${clip(c.new.replace(/\s+/g, ' '), 50)}`) });

if (report.moved.length)
	fields.push({ name: `Moved between chunks (${report.moved.length})`, value: list(report.moved, m => `${code(m.key)}: ${m.from} → ${m.to}`) });

if (orphanTotal)
	fields.push({
		name: `Orphaned, not deleted (${orphanTotal})`,
		value: list(Object.entries(report.orphaned), ([cmp, keys]) => `**${cmp}** (${keys.length}): ${keys.slice(0, 6).map(code).join(', ')}${keys.length > 6 ? ', …' : ''}`)
	});

if (report.conflicts.length)
	fields.push({ name: `Conflicting phrases (${report.conflicts.length})`, value: list(report.conflicts, c => `${code(c.key)}: ${c.variants.map(v => clip(JSON.stringify(v.phrase), 40)).join(' vs ')}`) });

if (errors || warnings)
	fields.push({ name: `Extractor diagnostics`, value: list(report.issues.filter(i => i.level !== 'info'), i => `[${i.level}] ${i.type} ${code(i.loc)}`) });

const links = [];
if (process.env.COMMIT_URL) links.push(`[i18n commit](${process.env.COMMIT_URL})`);
if (sourceSha) links.push(`[source ${sourceSha.slice(0, 7)}](https://github.com/${sourceRepo}/commit/${sourceSha})`);
if (process.env.RUN_URL) links.push(`[workflow run](${process.env.RUN_URL})`);
links.push(`[Weblate](${WEBLATE})`);

const summary = [
	`**${report.extracted}** strings extracted from ${code(sourceRepo)}.`,
	`Added **${report.added.length}**, changed **${report.changed.length}**, moved **${report.moved.length}**, orphaned **${orphanTotal}**, conflicts **${report.conflicts.length}**.`,
	report.shared_with_core?.length ? `${report.shared_with_core.length} add-on keys already defined by core were skipped.` : null,
	'',
	links.join(' · ')
].filter(l => l !== null).join('\n');

const color = report.conflicts.length || errors ? 0xE74C3C : orphanTotal ? 0xF1C40F : report.added.length + report.changed.length ? 0x2ECC71 : 0x95A5A6;

const embed = {
	title: clip(`i18n strings updated: ${report.repo}`, 256),
	description: clip(summary, 4096),
	color,
	fields: fields.slice(0, 25),
	timestamp: new Date().toISOString(),
	footer: { text: 'FrankerFaceZ i18n extraction' }
};

// Keep the whole embed under Discord's 6000 character budget.
let budget = embed.title.length + embed.description.length + embed.footer.text.length;
embed.fields = embed.fields.filter(f => {
	const size = f.name.length + f.value.length;
	if (budget + size > 5800) return false;
	budget += size;
	return true;
});

const res = await fetch(webhook, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ embeds: [embed] })
});

if (!res.ok) {
	console.error(`Discord webhook failed: ${res.status} ${res.statusText}\n${await res.text()}`);
	process.exit(1);
}

console.log('Posted merge report to Discord.');
