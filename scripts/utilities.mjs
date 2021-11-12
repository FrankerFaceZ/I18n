'use strict';

import GTP from 'gettext-parser';
const po = GTP.po;

const MAPPED_ADDON_ENTRIES = {
	'deck': 'deck',
	'ffzap.betterttv': 'ffzap-bttv',
	'ffzap.core': 'ffzap-core',
	'ffzap.liriklive': 'ffzap-liriklive'
};

const MAPPED_ADDON_KEYS = {
	'better_ttv_emotes': 'ffzap-bttv',
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


export function keyHasMarkdown(key) {
	if ( KNOWN_MARKDOWN.includes(key) )
		return true;

	return SETTING_TEST.test(key) && key.endsWith('.description');
}

export function getFlags(key) {
	return `icu-message-format${keyHasMarkdown(key) ? ', md-text' : ''}`;
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

	for(const [key, string] of Object.entries(strings)) {
		const thing = string.default ? string : {
			...original_strings[key],
			default: string
		};

		const [placeholders, extracted] = getExtraContext(thing);
		const [sources, context] = fixSources(thing.source);
		const flags = getFlags(key);

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