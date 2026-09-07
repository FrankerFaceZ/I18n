'use strict';

// ============================================================================
// Merge extracted strings into the catalog and PO files.
//
//   node scripts/merge.mjs extract/meta.json [--report extract/report.json] [--dry-run]
//
// Takes the meta.json written by scripts/extract.js and:
//   * adds new keys to strings.json and the component's en-US.po
//   * updates the English phrase, source references and placeholders of
//     existing keys
//   * moves keys (and their translations) between components when the
//     extraction says they belong elsewhere, e.g. an add-on chunk rename
//   * logs every catalog key the extraction no longer found ("orphaned").
//     Orphans are never deleted automatically: some strings only exist at
//     runtime (computed select-box options, server-driven settings).
//
// Nothing here touches git. The workflow commits the result.
// ============================================================================

import fs from 'fs';
import path from 'path';
import GTP from 'gettext-parser';
import { componentToPO, fixSources, GetSortedEntries, SortObject, readPOFile } from './utilities.mjs';

const po = GTP.po;

// The `embed` component belongs to the link service, whose rich-content
// tokens the client renders. Core owns `client` and `settings`; the few
// `embed.*` keys core itself uses (YouTube ToS warnings) live in `client`.
const CORE_COMPONENTS = ['client', 'settings'];
const MAX_SOURCE_LENGTH = 512;
const MARKDOWN_KINDS = new Set(['markdown', 'setting-description', 'category-description']);


// ----------------------------------------------------------------------------
// Arguments
// ----------------------------------------------------------------------------

const args = process.argv.slice(2);
let metaFile = null, reportFile = null, dryRun = false;

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === '--report') reportFile = args[++i];
	else if (arg === '--dry-run') dryRun = true;
	else if (arg === '--help' || arg === '-h') {
		console.log('Usage: node scripts/merge.mjs extract/meta.json [--report FILE] [--dry-run]');
		process.exit(0);
	} else if (!metaFile) metaFile = arg;
	else { console.error(`Unknown argument: ${arg}`); process.exit(2); }
}

if (!metaFile) {
	console.error('Usage: node scripts/merge.mjs extract/meta.json [--report FILE] [--dry-run]');
	process.exit(2);
}


// ----------------------------------------------------------------------------
// Component assignment
// ----------------------------------------------------------------------------

// Core keys are split into the two chunks the client loads for itself.
function coreComponent(key) {
	if (/^(settings?|home|addon)\./.test(key)) return 'settings';
	return 'client';
}

// Add-on keys live in one chunk per add-on, named after the add-on's source
// directory, which is also its id and therefore the chunk the client loads.
function addonComponents(entry) {
	return entry.dirs.map(dir => `addon.${dir}`);
}


// ----------------------------------------------------------------------------
// Load inputs
// ----------------------------------------------------------------------------

const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const isCore = meta.repo === 'core';
const isLinkService = meta.repo === 'link-service';
const catalog = JSON.parse(fs.readFileSync('strings.json', 'utf8'));

// Components a run owns, and therefore may report orphans in.
const inScope = cmp =>
	isCore ? CORE_COMPONENTS.includes(cmp) :
		isLinkService ? cmp === 'embed' :
			cmp.startsWith('addon.');
const scopedComponents = () => Object.keys(catalog).filter(inScope);

// Which component(s) currently hold a key, anywhere in the catalog. Searching
// everywhere lets a key that changes owner (e.g. link-service error strings
// that used to be filed under `client`) move with its translations instead of
// being duplicated.
function findExisting(key) {
	return findAnywhere(key);
}

function findAnywhere(key) {
	return Object.keys(catalog).filter(cmp => Object.prototype.hasOwnProperty.call(catalog[cmp], key));
}


// ----------------------------------------------------------------------------
// Merge
// ----------------------------------------------------------------------------

const report = {
	repo: meta.repo,
	root: meta.root,
	generated: meta.generated,
	extracted: Object.keys(meta.entries).length,
	added: [],
	changed: [],
	moved: [],
	orphaned: {},
	shared_with_core: [],
	conflicts: [],
	diagnostics: meta.diagnostics,
	issues: meta.issues.filter(i => i.level !== 'info'),
	touched_components: [],
	repaired_files: []
};

const modified = new Set();       // components whose en-US.po must be regenerated
const moves = [];                 // {key, from, to}
const seen = new Map();           // component -> Set(keys) found by extraction

function buildEntry(key, cmp, entry) {
	return {
		id: key,
		doc: cmp,
		default: entry.phrase,
		source: entry.calls.map(c => `/${c}`).join('\n').slice(0, MAX_SOURCE_LENGTH) || null,
		context: null,
		placeholders: entry.variables.length ? entry.variables : undefined,
		markdown: entry.kinds.some(k => MARKDOWN_KINDS.has(k)) || undefined
	};
}

// Update an existing catalog entry in place. Returns true if the English
// phrase changed (which is what translators care about).
function updateEntry(old, fresh) {
	let phraseChanged = false, metaChanged = false;

	if (fresh.default !== old.default) {
		report.changed.push({ key: old.id, component: fresh.doc, old: old.default, new: fresh.default });
		old.default = fresh.default;
		phraseChanged = true;
	}

	// gettext identifies a unit by msgctxt + msgid. The PO writer derives
	// msgctxt from the non-file lines of `source` (historically "FFZ Control
	// Center" for settings strings), so keep those lines when replacing the
	// source references or Weblate would see every such string as new.
	if (old.source) {
		const [, oldContext] = fixSources(old.source);
		if (oldContext && !(fresh.source || '').includes(oldContext))
			fresh.source = `${fresh.source ? `${fresh.source}\n` : ''}${oldContext}`;
	}

	for (const field of ['source', 'placeholders', 'markdown']) {
		const a = JSON.stringify(old[field] ?? null), b = JSON.stringify(fresh[field] ?? null);
		if (a !== b) {
			old[field] = fresh[field];
			metaChanged = true;
		}
	}

	if (old.doc !== fresh.doc) { old.doc = fresh.doc; metaChanged = true; }
	return phraseChanged || metaChanged;
}

for (const [key, entry] of GetSortedEntries(meta.entries)) {
	if (entry.conflict)
		report.conflicts.push({ key, variants: entry.conflict });

	let targets = isCore ? [coreComponent(key)] : isLinkService ? ['embed'] : addonComponents(entry);
	if (!targets.length) continue;

	// Keys that core defines stay with core. Add-ons reusing one get the core
	// translation for free, and the link service shares a handful of rich-token
	// keys (clip.*, video.*) with the client's own link providers. Without this
	// rule those keys would bounce between `client` and `embed` on every run.
	if (!isCore) {
		const coreOwners = findAnywhere(key).filter(c => CORE_COMPONENTS.includes(c));
		if (coreOwners.length) {
			report.shared_with_core.push({ key, component: coreOwners[0], addons: entry.dirs });
			continue;
		}
	}

	const existing = findExisting(key);
	const stale = existing.filter(c => !targets.includes(c));

	for (const cmp of targets) {
		(seen.get(cmp) ?? seen.set(cmp, new Set()).get(cmp)).add(key);
		const fresh = buildEntry(key, cmp, entry);

		if (existing.includes(cmp)) {
			if (updateEntry(catalog[cmp][key], fresh)) modified.add(cmp);
			continue;
		}

		// Prefer moving an entry that is no longer wanted where it is, so the
		// translations travel with it.
		const from = stale.shift();
		if (from) {
			const old = catalog[from][key];
			delete catalog[from][key];
			catalog[cmp] = catalog[cmp] ?? {};
			catalog[cmp][key] = old;
			updateEntry(old, fresh);
			moves.push({ key, from, to: cmp });
			report.moved.push({ key, from, to: cmp });
			modified.add(from);
			modified.add(cmp);
			continue;
		}

		catalog[cmp] = catalog[cmp] ?? {};
		catalog[cmp][key] = fresh;
		report.added.push({ key, component: cmp, phrase: entry.phrase });
		modified.add(cmp);
	}

	// A key still in use, but no longer by this component. Treated as an
	// orphan of that component rather than deleted.
	for (const cmp of stale)
		(report.orphaned[cmp] = report.orphaned[cmp] || []).push(key);
}

// Orphans: catalog keys in scope that the extraction did not produce.
for (const cmp of scopedComponents()) {
	const found = seen.get(cmp) ?? new Set();
	// For add-ons, only judge components the scan actually covered, plus any
	// component that no longer has a source directory at all.
	if (!isCore && !found.size) {
		const dir = cmp.slice('addon.'.length);
		if (!fs.existsSync(path.join(meta.root, 'src', dir))) {
			report.orphaned[cmp] = Object.keys(catalog[cmp]).sort();
			continue;
		}
	}
	for (const key of Object.keys(catalog[cmp]))
		if (!found.has(key) && !moves.some(m => m.key === key && m.from === cmp))
			(report.orphaned[cmp] = report.orphaned[cmp] || []).push(key);
}
for (const [cmp, list] of Object.entries(report.orphaned)) {
	if (!list.length) delete report.orphaned[cmp];
	else list.sort();
}

report.touched_components = [...modified].sort();


// ----------------------------------------------------------------------------
// Write PO files
// ----------------------------------------------------------------------------

// PO files are parsed once and written back at the end if modified.
const PO_CACHE = new Map(); // file -> {data, dirty}

function loadPO(file) {
	let entry = PO_CACHE.get(file);
	if (!entry) {
		const read = readPOFile(file);
		// A file that needed encoding repair is written back even if untouched.
		entry = { data: read.data, dirty: read.repaired };
		if (read.repaired) report.repaired_files.push(file.split(path.sep).join('/'));
		PO_CACHE.set(file, entry);
	}
	return entry;
}

function createPO(file, like) {
	const entry = { data: { charset: like.charset, headers: { ...like.headers }, translations: { '': {} } }, dirty: true };
	PO_CACHE.set(file, entry);
	return entry;
}

function flushPOs() {
	for (const [file, entry] of PO_CACHE) {
		if (!entry.dirty) continue;
		if (translationCount(entry.data)) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, po.compile(entry.data));
		} else if (fs.existsSync(file))
			fs.unlinkSync(file);
	}
}

// Number of units with an actual translation (ignores the header and
// untranslated placeholders).
function translationCount(data) {
	let n = 0;
	for (const group of Object.values(data.translations || {}))
		for (const [id, unit] of Object.entries(group))
			if (id !== '' && unit.msgstr?.[0]?.length) n++;
	return n;
}

function existingLangFile(dir, fname) {
	if (!fs.existsSync(dir)) return fname;
	const norm = s => s.toLowerCase().replace(/_/g, '-');
	return fs.readdirSync(dir).find(f => f.endsWith('.po') && norm(f) === norm(fname)) ?? fname;
}

// Move a key's translations (every non-source language) from one component
// directory to another. Target language files are created with the source
// file's headers when missing. Returns the number of translations moved.
function moveTranslations(key, from, to) {
	const fromDir = path.join('strings', from), toDir = path.join('strings', to);
	if (!fs.existsSync(fromDir)) return 0;
	let moved = 0;

	for (const fname of fs.readdirSync(fromDir)) {
		if (!fname.endsWith('.po') || fname === 'en-US.po') continue;
		const src = loadPO(path.join(fromDir, fname));

		// Units live under their msgctxt group; a key may exist with and
		// without a context. Move every variant and keep its context.
		for (const [context, group] of Object.entries(src.data.translations || {})) {
			const unit = group[key];
			if (!unit || !unit.msgstr?.[0]?.length) continue;

			delete group[key];
			src.dirty = true;

			// Component directories are not consistent about `pt-BR.po` versus
			// `pt_BR.po`. Reuse whatever spelling the target directory already
			// has so a language never ends up split across two files.
			const target = path.join(toDir, existingLangFile(toDir, fname));
			const dst = PO_CACHE.get(target) ?? (fs.existsSync(target) ? loadPO(target) : createPO(target, src.data));
			const dgroup = dst.data.translations[context] = dst.data.translations[context] || {};
			if (!dgroup[key]?.msgstr?.[0]?.length) {
				dgroup[key] = { ...unit, msgid: key };
				dst.dirty = true;
				moved++;
			}
		}
	}
	return moved;
}

// A key newly added to a component may already have translations sitting in
// another component's language files (the catalog and the PO files have not
// always agreed). Adopt them rather than asking translators to redo the work.
function adoptTranslations(key, to) {
	let adopted = 0;
	for (const cmp of fs.readdirSync('strings')) {
		if (cmp === to || !fs.statSync(path.join('strings', cmp)).isDirectory()) continue;
		if (catalog[cmp]?.[key]) continue; // legitimately owned elsewhere
		adopted += moveTranslations(key, cmp, to);
	}
	return adopted;
}

report.translations_moved = 0;
report.translations_adopted = 0;
report.removed_components = [];

if (!dryRun) {
	for (const { key, from, to } of moves)
		report.translations_moved += moveTranslations(key, from, to);

	for (const { key, component } of report.added)
		report.translations_adopted += adoptTranslations(key, component);

	flushPOs();

	for (const cmp of modified) {
		const dir = path.join('strings', cmp);
		const entries = catalog[cmp] ?? {};

		if (!Object.keys(entries).length) {
			// Component emptied out (e.g. every key moved to a renamed chunk).
			// Whatever translations remain belong to keys no component has any
			// more, so the directory goes; the count is reported for review.
			delete catalog[cmp];
			let stale = 0;
			if (fs.existsSync(dir)) {
				for (const f of fs.readdirSync(dir))
					if (f.endsWith('.po') && f !== 'en-US.po') stale += translationCount(readPOFile(path.join(dir, f)).data);
				fs.rmSync(dir, { recursive: true, force: true });
			}
			report.removed_components.push({ component: cmp, stale_translations: stale });
			continue;
		}

		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'en-US.po'), componentToPO(cmp, entries));
	}

	const out = {};
	for (const [cmp, val] of GetSortedEntries(catalog))
		out[cmp] = SortObject(val);
	fs.writeFileSync('strings.json', JSON.stringify(out, null, '\t'));
}

if (reportFile) {
	fs.mkdirSync(path.dirname(reportFile), { recursive: true });
	fs.writeFileSync(reportFile, JSON.stringify(report, null, '\t'));
}


// ----------------------------------------------------------------------------
// Console log and GitHub Actions summary
// ----------------------------------------------------------------------------

const orphanTotal = Object.values(report.orphaned).reduce((a, b) => a + b.length, 0);
const lines = [];
const log = (...a) => lines.push(a.join(' '));

log(`# i18n merge: ${meta.repo}${dryRun ? ' (dry run)' : ''}`);
log('');
log(`Extracted ${report.extracted} strings. Added ${report.added.length}, changed ${report.changed.length}, moved ${report.moved.length}, orphaned ${orphanTotal}, conflicts ${report.conflicts.length}.`);
log(`Touched components: ${report.touched_components.join(', ') || 'none'}`);
if (report.shared_with_core.length)
	log(`Skipped ${report.shared_with_core.length} add-on keys that core already defines.`);
if (report.translations_moved || report.translations_adopted)
	log(`Translations carried along: ${report.translations_moved} moved with their keys, ${report.translations_adopted} adopted from other components.`);
for (const r of report.removed_components)
	log(`Removed empty component ${r.component}` + (r.stale_translations ? ` (discarded ${r.stale_translations} translations of keys no component defines)` : ''));
if (report.repaired_files.length)
	log(`Repaired invalid UTF-8 (byte-folded multibyte characters) in: ${report.repaired_files.join(', ')}`);

if (report.added.length) {
	log('', '## Added');
	for (const a of report.added) log(`- ${a.component} · \`${a.key}\` = ${JSON.stringify(a.phrase).slice(0, 100)}`);
}
if (report.changed.length) {
	log('', '## Changed');
	for (const c of report.changed) log(`- ${c.component} · \`${c.key}\`\n  - was: ${JSON.stringify(c.old).slice(0, 100)}\n  - now: ${JSON.stringify(c.new).slice(0, 100)}`);
}
if (report.moved.length) {
	log('', '## Moved');
	for (const m of report.moved) log(`- \`${m.key}\`: ${m.from} → ${m.to}`);
}
if (orphanTotal) {
	log('', '## Orphaned (in catalog, not found by extraction; NOT deleted)');
	for (const [cmp, keys] of Object.entries(report.orphaned)) {
		log(`- ${cmp}: ${keys.length}`);
		for (const k of keys) log(`  - \`${k}\``);
	}
}
if (report.conflicts.length) {
	log('', '## Conflicts (same key, different English phrases; first variant used)');
	for (const c of report.conflicts) {
		log(`- \`${c.key}\``);
		for (const v of c.variants) log(`  - ${JSON.stringify(v.phrase).slice(0, 100)} — ${v.calls.join(', ')}`);
	}
}
if (report.issues.length) {
	log('', '## Extractor warnings and errors');
	for (const i of report.issues) log(`- [${i.level}] ${i.type} ${i.loc}: ${i.message.split('\n')[0]}`);
}

const text = lines.join('\n');
console.log(text);

if (process.env.GITHUB_STEP_SUMMARY)
	fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');

if (process.env.GITHUB_ACTIONS) {
	for (const [cmp, keys] of Object.entries(report.orphaned))
		console.log(`::warning title=Orphaned strings in ${cmp}::${keys.length} key(s) no longer found by extraction: ${keys.slice(0, 20).join(', ')}${keys.length > 20 ? ', …' : ''}`);
	for (const c of report.conflicts)
		console.log(`::error title=Conflicting phrases::${c.key} has ${c.variants.length} different English phrases`);
	if (process.env.GITHUB_OUTPUT) {
		const changed = report.added.length + report.changed.length + report.moved.length > 0 || report.touched_components.length > 0;
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nadded=${report.added.length}\nupdated=${report.changed.length}\nmoved=${report.moved.length}\norphaned=${orphanTotal}\n`);
	}
}
