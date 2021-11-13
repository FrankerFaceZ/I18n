'use strict';

import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import GTP from 'gettext-parser';
import { keyToComponent } from './utilities.mjs';
import { v4 } from 'uuid';
import { componentToPO } from './utilities.mjs';
import { GetSortedEntries } from './utilities.mjs';
import { SortObject } from './utilities.mjs';

const po = GTP.po;

// This script is in charge of merging new strings into
// the existing strings. If strings are added or changed,
// a pull request is then automatically created to merge
// the changes into main.

// This script expects to be called with two parameters,
// those being a Twitch username and the name of a file
// with the data to merge in.


// arguments

const args = process.argv.slice(2);

const user = args[0];
const file = args[1];


// main

(async () => {

	let input;

	try {
		input = JSON.parse(await fs.promises.readFile(file, {encoding: 'utf8'}));
	} catch(err) {
		console.error('Unable to load input');
		console.error(err);
		process.exit(1);
	}

	console.log('User:', user);
	console.log('File: ', file);
	console.log('Strings:', input.length);

	const components = {};
	for(const entry of input) {
		if ( ! entry.key )
			continue;

		const cmp = keyToComponent(entry.key);

		let source = entry.calls ? entry.calls.join('\n').substr(0, 512) : null;
		if ( source?.includes('MainMenu.getSettingsTree') )
			source = 'FFZ Control Center';

		const context = entry.options ? JSON.stringify(entry.options) : null;

		const component = components[cmp] ?? (components[cmp] = []);

		component.push({
			id: entry.key,
			doc: cmp,
			default: entry.phrase,
			source,
			context
		});
	}

	console.log('Categories:', Object.keys(components).length);
	console.log('   ', Object.keys(components).join('  '));

	let existing;

	try {
		existing = JSON.parse(await fs.promises.readFile('strings.json', {encoding: 'utf8'}));
	} catch(err) {
		console.error('Unable to load existing strings');
		console.error(err);
		process.exit(1);
	}

	const changed = [];
	const added = [];
	const modified = new Set();

	for(const [cmp, strings] of Object.entries(components)) {
		const exist = existing[cmp] ?? (existing[cmp] = {});

		for(const entry of strings) {
			const key = entry.id,
				old = exist[key];

			if (old) {
				let update = false;

				if (entry.default && entry.default !== old.default) {
					old.default = entry.default;
					update = true;
				}

				if (entry.source && ! old.source) {
					old.source = entry.source;
					update = true;
				}

				if (entry.context && entry.context !== old.context) {
					old.context = entry.context;
					update = true;
				}

				if (update) {
					changed.push(key);
					modified.add(cmp);
				}

			} else {
				exist[key] = entry;
				added.push(key);
				modified.add(cmp);
			}
		}
	}

	console.log('Added:', added.length);
	console.log('Changed:', changed.length);

	if (! added.length && ! changed.length) {
		console.log('Nothing to do. Exiting.');
		return;
	}

	// Okay, so now we *do* have stuff to change. We need to
	// set up a new branch in git and make a pull request.

	const git = simpleGit();
	const bid = `sources/${v4()}`;

	try {
		await git.checkout('main');
		await git.pull();
		await git.checkout(["-b", bid]);

		const out = {};
		for(const [key,val] of GetSortedEntries(existing))
			out[key] = SortObject(val);

		await fs.promises.writeFile('strings.json', JSON.stringify(out, null, '\t'));
		await git.add('strings.json');

		for(const key of modified) {
			let out;
			try {
				out = await componentToPO(key, existing[key]);
			} catch(err) {
				console.error(key, err);
				console.log(existing[key]);
				process.exit(1);
			}

			const dir = path.join('strings', key);

			try {
				await fs.promises.mkdir(dir, {recursive: true});
			} catch(err) {
				console.error(err);
				continue;
			}

			const fn = path.join(dir, 'en-US.po');
			await fs.promises.writeFile(fn, out);
			await git.add(fn);
		}

		await git.commit(`Add ${added.length} strings and update ${changed.length} strings.`, undefined, {'--author': `"${user}" <bot@frankerfacez.com>`});
		await git.push('origin', bid);
		await git.checkout('main');

	} catch(err) {
		console.error('Error while running Git commands.');
		console.error(err);
		process.exit(1);
	}

	console.log('New strings have been submitted to the repository under the branch:')
	console.log('   ', bid);

})();