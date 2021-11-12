'use strict';

import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import GTP from 'gettext-parser';
import raw_rimraf from 'rimraf';
import { getFlags, fixSources, flatten } from './utilities.mjs';
import { stringsToComponents } from './utilities.mjs';
import { componentToPO } from './utilities.mjs';

const rimraf = promisify(raw_rimraf);
const po = GTP.po;

async function fetchStrings() {
	const strings = {};
	let page = 1, pages = 1;

	while(page <= pages) {
		const resp = await fetch(`https://api-test.frankerfacez.com/v2/i18n/strings?page=${page}`);
		if ( resp.ok ) {
			const data = await resp.json();
			pages = data?.pages ?? 1;
			page++;
			if ( data && Array.isArray(data.strings) )
				for(const string of data.strings)
					strings[string.id] = string;
		}
	}

	return strings;
}


async function fetchLocales() {
	const resp = await fetch(`https://api-test.frankerfacez.com/v2/i18n/locales`);
	if ( resp.ok ) {
		const data = await resp.json();
		if ( Array.isArray(data) )
			return data;
	}

	return null;
}


async function fetchLocale(locale) {
	const resp = await fetch(`https://api-test.frankerfacez.com/v2/i18n/locale/${locale}`);
	if ( ! resp.ok )
		return null;

	return resp.json();
}


function localeToPO(component, sources, strings, lang) {
	const out = {},
		thing = {
			charset: 'utf-8',
			translations: {
				'': out
			}
		};

	let count = 0;

	for(const [key, source] of Object.entries(sources)) {
		if ( ! strings[key] )
			continue;

		count++;
		out[key] = {
			msgid: key,
			msgstr: [strings[key]]
		}
	};

	if ( ! count )
		return null;

	return po.compile(thing);
}


fetchStrings().then(stringsToComponents).then(async data => {
	const _locales = await fetchLocales(),
		locales = {};

	if ( _locales )
		for(const locale of _locales) {
			if ( locale.id === 'en' )
				continue;

			const ld = await fetchLocale(locale.id);
			if ( ld?.phrases )
				locales[locale.id] = ld.phrases;
		}

	await rimraf('strings');

	for(const [key, val] of Object.entries(data)) {
		const dir = path.join('strings', key);
		try {
			fs.mkdirSync(dir, {recursive: true});
		} catch(err) {
			console.error(err);
			continue;
		}

		// English
		const out = await componentToPO(key, val);
		fs.writeFileSync(path.join(dir, 'en-US.po'), out);

		// Locales
		for(const [locale, strings] of Object.entries(locales)) {
			let out;
			try {
				out = await localeToPO(key, val, strings, locale);
			} catch(err) {
				console.log('Batch', key, 'Locale', locale);
				console.error(err);
				continue;
			}
			if ( out )
				fs.writeFileSync(path.join(dir, `${locale}.po`), out);
		}
	}

	fs.writeFileSync('strings.json', JSON.stringify(data, null, '\t'));
});
