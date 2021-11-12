'use strict';

import crypto from 'crypto';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import GTP from 'gettext-parser';
import raw_rimraf from 'rimraf';

const rimraf = promisify(raw_rimraf);
const po = GTP.po;


// main()

(async () => {

const dirs = await fs.promises.readdir('strings');

await rimraf('dist');
await fs.promises.mkdir(path.join('dist'), {recursive: true});

const locales = JSON.parse(await fs.promises.readFile('locales.json', {encoding: 'utf8'}));

const output = {};

for(const name of dirs) {
	const dirname = path.join('strings', name);
	let stat;
	try {
		stat = await fs.promises.stat(dirname);
	} catch(err) { /* no-op */ }

	if (!stat?.isDirectory())
		continue;

	const files = await fs.promises.readdir(dirname);
	for(const fname of files) {
		if (! fname.endsWith('.po'))
			continue;

		const lang = fname.slice(0, -3);
		const strings = {};

		const full = path.join(dirname, fname);
		let data;
		let raw;

		try {
			raw = po.parse(await fs.promises.readFile(full, {encoding: 'utf-8'}));
			data = raw?.translations;
		} catch(err) {
			console.error('Unable to process file', full);
			console.error(err);
			continue;
		}

		if (! data)
			continue;

		for(const group of Object.values(data)) {
			for(const entry of Object.values(group)) {
				if (entry?.msgid && entry.msgstr)
					strings[entry.msgid] = entry.msgstr[0];
			}
		}

		const modules = output[lang] ?? (output[lang] = {});
		const out = JSON.stringify(strings);

		modules[name] = {
			strings: Object.keys(strings).length,
			out,
			hash: crypto.createHash('sha256').update(out).digest('hex').slice(0,20)
		};
	}
}


// Count the strings in the source language.
const total = Object.values(output['en-US']).reduce((a,b) => a + b.strings, 0);
console.log('Total Strings:', total);

const manifest = {};

for(const entry of locales) {
	manifest[entry.id] = entry;
}

const promises = [];

for(const lang of Object.keys(output)) {
	const modules = output[lang];
	const strings = Object.values(modules).reduce((a,b) => a + b.strings, 0);

	const hashes = {},
		lm = manifest[lang === 'en-US' ? 'en' : lang];
	if (! lm) {
		console.error('Missing locale data:', lang);
		continue;
	}

	lm.coverage = Math.min(100, Math.floor(1000 * strings / total) / 10);
	lm.hashes = hashes;

	if (lang !== 'en-US') {
		await fs.promises.mkdir(path.join('dist', lang));

		for(const [key, module] of Object.entries(modules)) {
			hashes[key] = module.hash;
			promises.push(fs.promises.writeFile(path.join('dist', lang, `${key}.${module.hash}.json`), module.out))
		}
	}
}

await Promise.all(promises);

const compare = new Intl.Collator();

const vals = Object.values(manifest);
vals.sort((a,b) => compare.compare(a.id, b.id));

const out = JSON.stringify(vals);
const hash = crypto.createHash('sha256').update(out).digest('hex').slice(0,20);

await fs.promises.writeFile(path.join('dist', `locales.${hash}.json`), out);
await fs.promises.writeFile(path.join('dist', 'manifest.json'), JSON.stringify({
	'locale/locales.json': `locale/locales.${hash}.json`
}));

})();