'use strict';

// ============================================================================
// Repair PO files that are not valid UTF-8.
//
//   node scripts/repair-encoding.mjs [--check]
//
// The 2021 import folded long lines on bytes instead of characters, splitting
// multibyte UTF-8 sequences across line breaks. Every byte is still present,
// so the files are rebuilt losslessly: parse as Latin-1 (which reassembles the
// folded pieces), re-decode each string as UTF-8, and write back with proper
// folding and an explicit charset. With --check, only report; exit 1 if any
// file needs repair.
// ============================================================================

import fs from 'fs';
import path from 'path';
import GTP from 'gettext-parser';
import { readPOFile } from './utilities.mjs';

const check = process.argv.includes('--check');
const po = GTP.po;

function* poFiles(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* poFiles(full);
		else if (entry.name.endsWith('.po')) yield full;
	}
}

function unitCount(data) {
	let n = 0;
	for (const group of Object.values(data.translations || {}))
		for (const id of Object.keys(group))
			if (id !== '') n++;
	return n;
}

let repaired = 0, failed = 0;

for (const file of poFiles('strings')) {
	const read = readPOFile(file);
	if (!read.repaired) continue;

	const rel = file.split(path.sep).join('/');
	if (check) {
		console.log(`needs repair: ${rel}`);
		repaired++;
		continue;
	}

	const before = unitCount(read.data);
	const output = po.compile(read.data);

	// Verify the round trip before touching the file.
	const verify = po.parse(output, 'utf-8');
	const after = unitCount(verify);
	let valid = true;
	try { new TextDecoder('utf-8', { fatal: true }).decode(output); } catch (err) { valid = false; }

	if (!valid || after !== before) {
		console.error(`NOT repaired (round-trip mismatch): ${rel} units ${before} -> ${after}, valid utf-8: ${valid}`);
		failed++;
		continue;
	}

	fs.writeFileSync(file, output);
	console.log(`repaired: ${rel} (${before} units)`);
	repaired++;
}

if (check) {
	console.log(repaired ? `${repaired} file(s) need repair.` : 'All PO files are valid UTF-8.');
	process.exit(repaired ? 1 : 0);
}

console.log(`Repaired ${repaired} file(s)${failed ? `, ${failed} failed` : ''}.`);
process.exit(failed ? 1 : 0);
