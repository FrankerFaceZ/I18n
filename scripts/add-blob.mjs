'use strict';

import simpleGit from 'simple-git';
import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';
import GTP from 'gettext-parser';
import { stringsToComponents } from './utilities.mjs';
import { keyToComponent } from './utilities.mjs';
import { v4 } from 'uuid';
import { componentToPO } from './utilities.mjs';

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

		let source = entry.calls.join('\n').substr(0, 512);
		if ( source.includes('MainMenu.getSettingsTree') )
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

	for(const [key, strings] of Object.entries(components)) {
		const exist = existing[key] ?? (existing[key] = {});

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
					modified.add(key);
				}

			} else {
				exist[key] = entry;
				added.push(key);
				modified.add(key);
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
	const bid = v4();

	try {
		await git.pull();
		await git.checkout(["-b", bid]);

		await fs.promises.writeFile('strings.json', JSON.stringify(existing));
		await git.add('strings.json');

		for(const key of modified) {
			const out = await componentToPO(key, existing[key]);
			const fn = path.join('strings', key, 'en-US.po');
			await fs.promises.writeFile(fn, out);
			await git.add(fn);
		}

		await git.commit(`Add ${added.length} strings and update ${changed.length} strings.`, undefined, {'--author': `"${user}" <bot@frankerfacez.com>`});

	} catch(err) {
		console.error('Error while running Git commands.');
		console.error(err);
		process.exit(1);
	}


})();