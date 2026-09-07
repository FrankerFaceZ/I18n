'use strict';

import fs from 'fs';
import GTP from 'gettext-parser';
const po = GTP.po;

const MAPPED_ADDON_ENTRIES = {
	'deck': 'deck',
	'seventv_emotes': '7tv-emotes',
	'ffzap.betterttv': 'ffzap-bttv',
	'ffzap.core': 'ffzap-core',
	'ffzap.liriklive': 'ffzap-liriklive'
};

const MAPPED_ADDON_KEYS = {
	'better_ttv_emotes': 'ffzap-bttv',
	'7tv_emotes': '7tv-emotes',
	'seventv_emotes': '7tv-emotes',
	'deck': 'deck',
	'ffz_ap_core': 'ffzap-core',
	'fs_chat': 'fs-chat',
	'inline_tab': 'inlinetab',
	'pronouns': 'pronouns'
};

const KNOWN_MARKDOWN = [
	'home.about',
	'home.addon-new',
	'home.addon-new.desc',
	'home.addon-updates',
	'home.addon-updates.desc',
	'home.faq',
	'home.feedback',
	'home.term-syntax'
];


const SETTING_TEST = /^settings?\.(entry\.)?(.+)$/,
	EMBED_TEST = /^embeds?\./,
	ADDON_TEST = /^add_?ons?\.([^\.]+)\.(.+)$/,
	BAD_ADDONS = ['dev', 'unlisted'],
	BAD_ADDON_KEYS = ['author', 'name'];


const sort = new Intl.Collator;


// ----------------------------------------------------------------------------
// PO file reading
// ----------------------------------------------------------------------------

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

export function isValidUTF8(buffer) {
	try {
		STRICT_UTF8.decode(buffer);
		return true;
	} catch (err) {
		return false;
	}
}

// Re-interpret every string in a parsed PO table that was decoded as
// Latin-1 as the UTF-8 it really is.
function latin1ToUTF8(value) {
	if ( typeof value === 'string' )
		return Buffer.from(value, 'latin1').toString('utf8');
	if ( Array.isArray(value) )
		return value.map(latin1ToUTF8);
	if ( value && typeof value === 'object' ) {
		const out = {};
		for(const [k, v] of Object.entries(value))
			out[latin1ToUTF8(k)] = latin1ToUTF8(v);
		return out;
	}
	return value;
}

/**
 * Read and parse a PO file as UTF-8.
 *
 * Files written by the 2021 import were line-folded on bytes rather than
 * characters, which split multibyte sequences across `"` `\n` `"` and left
 * them as invalid UTF-8. Such a file is parsed as Latin-1 (byte-transparent),
 * which reassembles the folded pieces, and every string is then re-decoded as
 * UTF-8. The result is flagged so callers can rewrite the file cleanly.
 *
 * @param {String} file Path to the PO file
 * @returns {{data: Object, repaired: boolean}}
 */
export function readPOFile(file) {
	const buffer = fs.readFileSync(file);
	if ( isValidUTF8(buffer) )
		return { data: po.parse(buffer, 'utf-8'), repaired: false };

	const raw = po.parse(buffer, 'iso-8859-1');
	const data = {
		charset: 'utf-8',
		headers: latin1ToUTF8(raw.headers),
		translations: latin1ToUTF8(raw.translations)
	};
	return { data, repaired: true };
}

export function GetSortedEntries(obj) {
	const entries = [...Object.entries(obj)];
	entries.sort((a,b) => sort.compare(a[0], b[0]));
	return entries;
}

export function SortObject(obj) {
	const result = {};
	for(const [key,val] of GetSortedEntries(obj))
		result[key] = val;
	return result;
}


export function keyToComponent(key) {
	let match = ADDON_TEST.exec(key);
	if ( match && ! BAD_ADDONS.includes(match[1]) && ! BAD_ADDON_KEYS.includes(match[2]) )
		return `addon.${match[1]}`;

	match = SETTING_TEST.exec(key);
	if ( match ) {
		// Is this an entry?
		if ( match[1] ) {
			for(const [key,val] of Object.entries(MAPPED_ADDON_ENTRIES)) {
				if ( match[2].startsWith(`${key}.`) )
					return `addon.${val}`;
			}

			const m2 = ADDON_TEST.exec(match[2]);
			if ( m2 && ! BAD_ADDONS.includes(m2[1]) )
				return `addon.${m2[1]}`;
		}

		if ( match[2].startsWith('add_ons.') ) {
			const trail = match[2].slice(8);
			for(const [key,val] of Object.entries(MAPPED_ADDON_KEYS)) {
				if ( trail === key || trail.startsWith(`${key}.`) )
					return `addon.${val}`;
			}
		}

		return 'settings';
	}

	if ( key.startsWith('addon.') )
		return 'settings';

	if ( key.startsWith('home.') )
		return 'settings';

	if ( EMBED_TEST.test(key) )
		return 'embed';

	return 'client';
}


export function stringsToComponents(strings) {
	const components = {};

	for(const [key, string] of Object.entries(strings)) {
		const cmp = keyToComponent(key),
			out = components[cmp] ?? (components[cmp] = {});

		out[key] = string;
	}

	return components;
}


export function keyHasMarkdown(key, entry) {
	if ( entry?.markdown )
		return true;

	if ( KNOWN_MARKDOWN.includes(key) )
		return true;

	return SETTING_TEST.test(key) && key.endsWith('.description');
}

export function getFlags(key, entry) {
	return `icu-message-format${keyHasMarkdown(key, entry) ? ', md-text' : ''}`;
}

export function fixSources(sources) {
	if ( ! Array.isArray(sources) )
		sources = sources.split(/\s*\n+\s*/);

	const out = [], context = [];
	for(const source of sources) {
		const match = /\((\/[^)]+?)(?:\?[^:]+)?(?::(\d+))?(?::\d+)?\)/.exec(source);
		if ( match ) {
			out.push(`${match[1]}${match[2] ? `:${match[2]}` : ''}`);
		} else if ( source.includes('/src/') )
			out.push(source);
		else
			context.push(source);
	}

	return [
		out.length ? out.join('\n') : null,
		context.length ? context.join('\n') : null
	];
}

export function flatten(obj, out, prefix) {
	if ( ! obj || typeof obj !== 'object' )
		return obj;

	if ( ! out )
		out = {};

	for(const [key, val] of Object.entries(obj)) {
		if ( val === undefined )
			continue;

		const prefixed = prefix ? `${prefix}.${key}` : key;

		if ( val && typeof val === 'object' ) {
			flatten(val, out, prefixed)
		} else
			out[prefixed] = val;
	}

	return out;
}


export function getExtraContext(thing) {
	let placeholders = '', context;
	if ( thing?.context ) {
		let stuff;
		try {
			stuff = flatten(JSON.parse(thing.context));
		} catch(err) { /* no-op */ }

		if ( typeof stuff === 'object' && ! Array.isArray(stuff) ) {
			placeholders = `placeholders:${Object.keys(stuff).join(':')}, `;
			try {
				context = JSON.stringify(stuff);
			} catch(err) { /* no-op */ }
		}
	}

	return [placeholders, context];
}


export function componentToPO(component, strings, original_strings, lang = 'en-US') {
	const out = {},
		thing = {
			charset: 'utf-8',
			translations: {
				'': out
			}
		};

	for(const [key, string] of GetSortedEntries(strings)) {
		const thing = string.default ? string : {
			...original_strings[key],
			default: string
		};

		const [placeholders, extracted] = getExtraContext(thing);
		const [sources, context] = fixSources(thing.source);
		const flags = getFlags(key, thing);

		out[key] = {
			msgid: key,
			msgstr: [thing.default],
			msgctxt: context ?? undefined,
			comments: {
				//extracted: extracted ?? undefined,
				reference: sources ?? undefined,
				flag: `${flags}${extracted ? `, lp-defaults:${JSON.stringify(extracted)}` : ''}`
			}
		}
	}

	return po.compile(thing);
}