#!/usr/bin/env node
'use strict';

// ============================================================================
// FrankerFaceZ i18n String Extractor
//
// Statically extracts every localizable key/phrase pair from the source tree
// so the English source strings can be uploaded to Weblate.
//
// It understands:
//   * Direct calls:      this.i18n.t(key, phrase), t.i18n.tList(...), this.t(...),
//                        and the Vue template helpers t() / tList().
//   * <t-list> component: <t-list phrase="key" default="phrase">
//   * Settings tree:     settings.add() / settings.addUI() definitions, including
//                        category paths, entry titles, descriptions, pills and
//                        select/combo box values. Mirrors main_menu/index.js and
//                        settings/index.ts key derivation.
//   * Metadata pairs:    object literals carrying `i18n_key` + `title`,
//                        `title_i18n` + `title`, `desc_i18n_key` + `description`, etc.
//   * Registries:        highlight reasons, chat actions & renderers, clearables,
//                        storage providers, AutoMod descriptions, emoji categories,
//                        and the markdown home pages.
//
// Usage:
//   node scripts/extract.js --root DIR [--out DIR] [--by-dir] [--webext] [--strict] [--quiet]
//
//   --root DIR   Checkout of the repository to scan: FrankerFaceZ (core) or Add-Ons.
//                The core repo is detected by the presence of src/i18n.js.
//   --by-dir     Also write strings.<dir>.json per top-level src/ directory, which
//                for the add-ons repo means one file per add-on.
//
// Outputs (in --out, default ./extract):
//   meta.json           the input for scripts/merge.mjs: per-key phrase, variables,
//                       kinds, call sites and source directories, plus diagnostics.
//   strings.json        flat {key: phrase}, sorted.
//   strings.webext.json {key: {message, description}} (only with --webext).
// ============================================================================

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { globSync } = require('glob');
const compiler = require('vue-template-compiler');
const IcuParser = require('@ffz/icu-msgparser');

const ARGS = parseArgs(process.argv.slice(2));

if (!ARGS.root) {
	console.error('--root DIR is required: the checkout of FrankerFaceZ or Add-Ons to scan.');
	process.exit(2);
}

const ROOT = path.resolve(ARGS.root);

// Which repository is this? The core repository is the only one with the
// TranslationManager itself; the link service is the only one with the
// rich-token builder. Everything else is treated as the add-ons repository.
let REPO, SRC, SOURCE_GLOB;
if (fs.existsSync(path.join(ROOT, 'src', 'i18n.js'))) {
	REPO = 'core'; SRC = path.join(ROOT, 'src'); SOURCE_GLOB = 'src/**/*.{js,jsx,ts,tsx,vue}';
} else if (fs.existsSync(path.join(ROOT, 'lib', 'builder.js'))) {
	REPO = 'link-service'; SRC = path.join(ROOT, 'lib'); SOURCE_GLOB = 'lib/**/*.js';
} else if (fs.existsSync(path.join(ROOT, 'src'))) {
	REPO = 'addons'; SRC = path.join(ROOT, 'src'); SOURCE_GLOB = 'src/**/*.{js,jsx,ts,tsx,vue}';
} else {
	console.error(`Cannot recognise ${ROOT}: expected src/ (FrankerFaceZ, Add-Ons) or lib/builder.js (link-service).`);
	process.exit(2);
}

const IS_CORE = REPO === 'core';
const IS_LINK_SERVICE = REPO === 'link-service';
const MD_DIR = path.join(SRC, 'modules', 'main_menu');
const OUT_DIR = path.resolve(process.cwd(), ARGS.out || 'extract');

const T_METHODS = new Set(['t', 'tList']);
const SELECT_COMPONENTS = new Set(['setting-select-box', 'setting-combo-box']);

// Object-literal metadata pairs: property holding the i18n key -> property
// holding the default phrase. Mirrors `t(x.<i18n prop>, x.<text prop>)` usage
// throughout the Vue components and JSX renderers.
const META_PAIRS = [
	['i18n_key', ['title', 'name']],
	['desc_i18n_key', ['description']],
	['title_i18n', ['title']],
	['text_i18n', ['text']],
	['description_i18n', ['description']],
	['i18n_label', ['label']],
	['label_i18n', ['label']],
	['i18n_links', ['links']],
	['i18n_accept', ['accept']],
	['pill_i18n_key', ['pill']],
	['name_i18n', ['name']],
	['short_name_i18n', ['short_name']],
	['author_i18n', ['author']],
	['maintainer_i18n', ['maintainer']],
	['source_i18n', ['source']],
	['menu_i18n_key', ['menu_name']],
	['desc_i18n', ['desc', 'description']],
	['sub_i18n', ['subtitle', 'sub']],
	['about_i18n', ['about']],
	['tip_i18n', ['tip', 'tooltip']],
	['i18n', ['title', 'text', 'name']]
];

// Array literals of the shape [key, phrase, data?] that are later spread into
// t(). Used by the Deck add-on's column classes. Guarded by key shape so plain
// string arrays are not mistaken for it.
const KEY_SHAPE = /^[a-z0-9_-]+(?:\.[a-z0-9_:-]+)+$/i;

// Methods that take (key, phrase) like t() does. `i18nToken` and `addI18n`
// belong to the link service's rich-token builder; the client renders those
// tokens through i18n.tList(key, phrase, content).
const T_LIKE_METHODS = new Set(['addError', 'i18nToken', 'addI18n']);

// Dynamic key prefixes that a registry handler below fully covers. Calls
// using them are reported as info instead of warnings.
const COVERED_PREFIXES = [
	'emoji.category.',
	'chat.filtering.automod.',
	'setting.clear.opt.',
	'home.'
];

const IGNORE = [
	'**/*.disabled',
	'**/*.old',
	'**/*.old.*',
	'**/* copy.*',
	'**/*.d.ts',
	'**/*.test.*',
	'src/ffz_injector.user.js'
];

const icu = new IcuParser({ allowTags: false, requireOther: false });


// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--out') out.out = argv[++i];
		else if (arg === '--root') out.root = argv[++i];
		else if (arg === '--by-dir') out.byDir = true;
		else if (arg === '--webext') out.webext = true;
		else if (arg === '--strict') out.strict = true;
		else if (arg === '--quiet') out.quiet = true;
		else if (arg === '--help' || arg === '-h') {
			console.log('Usage: node bin/extract_i18n.js [--root DIR] [--out DIR] [--by-dir] [--webext] [--strict] [--quiet]');
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${arg}`);
			process.exit(2);
		}
	}
	return out;
}


// ============================================================================
// Ports of runtime helpers (utilities/events.ts, utilities/path-parser.ts)
// ============================================================================

const SNAKE_CAPS = /([a-z])([A-Z])/g,
	SNAKE_SPACE = /[ \t\W]/g,
	SNAKE_TRIM = /^_+|_+$/g;

function toSnakeCase(input) {
	return input
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.trim()
		.replace(SNAKE_CAPS, '$1_$2')
		.replace(SNAKE_SPACE, '_')
		.replace(SNAKE_TRIM, '')
		.toLowerCase();
}

function parsePath(str) {
	const ctx = { path: str, i: 0 };
	const length = str.length, out = [];
	let token = null, raw = null;
	let old_tab = false, old_page = false;

	while (ctx.i < length) {
		const start = ctx.i, char = str[start], next = str[start + 1];
		if (!token) token = {};
		if (!raw) raw = '';

		if (char === '@' && next === '{') {
			ctx.i++;
			const tag = parsePathJSON(ctx);
			if (tag) Object.assign(token, tag);
			continue;
		}

		const tab = char === '~' && next === '>',
			page = char === '>' && next === '>',
			segment = !page && char === '>';

		if (!segment && !page && !tab) {
			raw += char;
			ctx.i++;
			continue;
		}

		if (tab || page) ctx.i++;

		token.title = raw.trim();
		token.key = toSnakeCase(token.title);
		token.page = old_page;
		token.tab = old_tab;
		old_page = page;
		old_tab = tab;
		out.push(token);
		token = raw = null;
		ctx.i++;
	}

	if (token && raw) {
		token.title = raw.trim();
		token.key = toSnakeCase(token.title);
		token.page = old_page;
		token.tab = old_tab;
		out.push(token);
	}

	return out;
}

function parsePathJSON(ctx) {
	const str = ctx.path, length = str.length, start = ctx.i;
	ctx.i++;
	const stack = ['{'];
	let string = false;

	while (ctx.i < length && stack.length) {
		const char = str[ctx.i];
		if (string) {
			if (char === '\\') { ctx.i++; continue; }
			if ((char === '"' || char === "'") && char === string) { stack.pop(); string = false; }
		} else {
			if (char === '"' || char === "'") { string = char; stack.push(char); }
			if (char === '{' || char === '[') stack.push(char);
			if (char === ']' && stack.pop() !== '[') throw new SyntaxError('Invalid JSON');
			if (char === '}' && stack.pop() !== '{') throw new SyntaxError('Invalid JSON');
		}
		ctx.i++;
	}

	return JSON.parse(str.slice(start, ctx.i));
}


// ============================================================================
// Store
// ============================================================================

const entries = new Map(); // key -> { key, phrases: Map<phrase, Set<call>>, kinds: Set }
const diagnostics = [];

function record(key, phrase, loc, kind) {
	if (typeof key !== 'string' || !key.length) return;
	if (typeof phrase !== 'string') return;

	let entry = entries.get(key);
	if (!entry) {
		entry = { key, phrases: new Map(), kinds: new Set() };
		entries.set(key, entry);
	}

	let calls = entry.phrases.get(phrase);
	if (!calls) {
		calls = new Set();
		entry.phrases.set(phrase, calls);
	}
	calls.add(loc);
	entry.kinds.add(kind);
}

function diag(level, type, loc, message) {
	diagnostics.push({ level, type, loc, message });
}


// ============================================================================
// TypeScript AST Helpers
// ============================================================================

function scriptKindFor(file, lang) {
	if (lang === 'ts') return ts.ScriptKind.TS;
	if (lang === 'tsx') return ts.ScriptKind.TSX;
	const ext = path.extname(file).toLowerCase();
	if (ext === '.ts') return ts.ScriptKind.TS;
	if (ext === '.tsx') return ts.ScriptKind.TSX;
	return ts.ScriptKind.JSX; // .js files in this repo may contain JSX.
}

function parseSource(code, file, kind) {
	return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
}

function unwrap(node) {
	while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
		ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) ||
		ts.isSatisfiesExpression?.(node)))
		node = node.expression;
	return node;
}

// Returns the string value of a literal, or null when it is dynamic. Falls back
// to the active constant resolver for identifiers, `this.FIELD`, `NS.CONST`,
// and template literals built from those.
let RESOLVER = null;

function getString(node, depth = 0) {
	node = unwrap(node);
	if (!node || depth > 8) return null;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const l = getString(node.left, depth + 1), r = getString(node.right, depth + 1);
		if (l !== null && r !== null) return l + r;
		return null;
	}
	if (ts.isTemplateExpression(node)) {
		let out = node.head.text;
		for (const span of node.templateSpans) {
			const val = getString(span.expression, depth + 1);
			if (val === null) return null;
			out += val + span.literal.text;
		}
		return out;
	}
	if (RESOLVER) return RESOLVER.resolve(node, depth + 1);
	return null;
}


// ============================================================================
// Constant Resolver
//
// Resolves string constants referenced by a t()/settings.add() key: top-level
// `const X = '...'`, `const OBJ = {x: '...'}`, class fields (`this.PREFIX`),
// `this.X = '...'` assignments in constructors, and constants imported from a
// relative module (named, default, or `import * as NS`).
// ============================================================================

const MODULE_CACHE = new Map(); // absolute file -> Resolver | null
const RESOLVE_EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

class Resolver {
	constructor(sf, file) {
		this.sf = sf;
		this.file = file;
		this.constants = new Map(); // name -> initializer node
		this.exports = new Map();   // exported name -> initializer node
		this.classProps = new Map(); // field name -> initializer node
		this.imports = new Map();   // local name -> {file, name}

		for (const stmt of sf.statements) {
			if (ts.isVariableStatement(stmt)) {
				const exported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
				for (const decl of stmt.declarationList.declarations) {
					if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
					this.constants.set(decl.name.text, decl.initializer);
					if (exported) this.exports.set(decl.name.text, decl.initializer);
				}
			} else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
				const spec = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
				if (!spec || !spec.startsWith('.')) continue;
				const target = path.resolve(ROOT, path.dirname(file), spec);
				const clause = stmt.importClause;
				if (clause.name) this.imports.set(clause.name.text, { file: target, name: 'default' });
				const bindings = clause.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings))
					this.imports.set(bindings.name.text, { file: target, name: '*' });
				else if (bindings && ts.isNamedImports(bindings))
					for (const el of bindings.elements)
						this.imports.set(el.name.text, { file: target, name: (el.propertyName || el.name).text });
			} else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
				this.exports.set('default', stmt.expression);
			}
		}

		const visitClass = node => {
			if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
				for (const member of node.members) {
					if (ts.isPropertyDeclaration(member) && member.initializer) {
						const name = propName(member);
						if (name !== null && !this.classProps.has(name)) this.classProps.set(name, member.initializer);
					} else if (ts.isConstructorDeclaration(member) && member.body) {
						for (const stmt of member.body.statements) {
							if (!ts.isExpressionStatement(stmt)) continue;
							const expr = stmt.expression;
							if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
								ts.isPropertyAccessExpression(expr.left) && expr.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
								const name = expr.left.name.text;
								if (!this.classProps.has(name)) this.classProps.set(name, expr.right);
							}
						}
					}
				}
			}
			ts.forEachChild(node, visitClass);
		};
		visitClass(sf);
	}

	// Resolve with this resolver active, restoring the previous one after.
	with(fn) {
		const prev = RESOLVER;
		RESOLVER = this;
		try { return fn(); } finally { RESOLVER = prev; }
	}

	resolve(node, depth) {
		node = unwrap(node);
		if (!node) return null;

		if (ts.isIdentifier(node)) {
			const local = this.constants.get(node.text);
			if (local) return this.with(() => getString(local, depth));
			const imp = this.imports.get(node.text);
			if (imp && imp.name !== '*') return this.external(imp.file, imp.name, depth);
			return null;
		}

		if (ts.isPropertyAccessExpression(node)) {
			const name = node.name.text;
			const obj = unwrap(node.expression);

			if (obj.kind === ts.SyntaxKind.ThisKeyword) {
				const init = this.classProps.get(name);
				return init ? this.with(() => getString(init, depth)) : null;
			}

			if (ts.isIdentifier(obj)) {
				const imp = this.imports.get(obj.text);
				if (imp && imp.name === '*') return this.external(imp.file, name, depth);

				const target = this.resolveObject(obj, depth);
				if (target) {
					const prop = getProp(target.node, name);
					return prop ? target.resolver.with(() => getString(prop, depth)) : null;
				}
			}
			return null;
		}

		if (ts.isElementAccessExpression(node)) {
			const idx = getString(node.argumentExpression, depth);
			if (idx === null || !ts.isIdentifier(unwrap(node.expression))) return null;
			const target = this.resolveObject(unwrap(node.expression), depth);
			if (!target) return null;
			const prop = getProp(target.node, idx);
			return prop ? target.resolver.with(() => getString(prop, depth)) : null;
		}

		return null;
	}

	// Resolve an identifier to an object literal, possibly in another module.
	resolveObject(ident, depth) {
		const local = this.constants.get(ident.text);
		if (local) {
			const init = unwrap(local);
			return ts.isObjectLiteralExpression(init) ? { node: init, resolver: this } : null;
		}
		const imp = this.imports.get(ident.text);
		if (!imp || imp.name === '*') return null;
		const mod = loadModule(imp.file);
		if (!mod) return null;
		const init = mod.exports.get(imp.name);
		if (!init) return null;
		const un = unwrap(init);
		return ts.isObjectLiteralExpression(un) ? { node: un, resolver: mod } : null;
	}

	external(file, name, depth) {
		const mod = loadModule(file);
		if (!mod) return null;
		const init = mod.exports.get(name);
		return init ? mod.with(() => getString(init, depth)) : null;
	}
}

function loadModule(base) {
	if (MODULE_CACHE.has(base)) return MODULE_CACHE.get(base);
	let found = null;
	for (const ext of RESOLVE_EXTS) {
		const candidate = base + ext;
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) { found = candidate; break; }
	}
	let resolver = null;
	if (found && !found.endsWith('.vue')) {
		try {
			const code = fs.readFileSync(found, 'utf8');
			const relFile = rel(found);
			resolver = new Resolver(parseSource(code, relFile, scriptKindFor(relFile)), relFile);
		} catch (err) { resolver = null; }
	}
	MODULE_CACHE.set(base, resolver);
	return resolver;
}

// Human readable summary of a dynamic key expression, e.g. `chat.actions.${…}`.
function describeExpr(node) {
	node = unwrap(node);
	if (!node) return '<none>';
	if (ts.isTemplateExpression(node)) {
		let out = node.head.text;
		for (const span of node.templateSpans)
			out += '${…}' + span.literal.text;
		return '`' + out + '`';
	}
	return node.getText().replace(/\s+/g, ' ').slice(0, 80);
}

// Expand a template literal whose only substitutions are conditionals with
// literal branches, e.g. `chat.sub.main${has_multi ? '-multi' : ''}`.
// Returns {conds: [text...], build(mask) -> string} or null.
function conditionalTemplate(node) {
	node = unwrap(node);
	if (!node) return null;

	const str = getString(node);
	if (str !== null) return { conds: [], build: () => str };

	const conds = [];
	const parts = [];

	const pushConditional = expr => {
		const yes = getString(expr.whenTrue), no = getString(expr.whenFalse);
		if (yes === null || no === null) return false;
		const cond = expr.condition.getText().replace(/\s+/g, ' ');
		let idx = conds.indexOf(cond);
		if (idx === -1) { idx = conds.length; conds.push(cond); }
		parts.push({ idx, yes, no });
		return true;
	};

	if (ts.isConditionalExpression(node)) {
		if (!pushConditional(node)) return null;
	} else if (ts.isTemplateExpression(node)) {
		parts.push(node.head.text);
		for (const span of node.templateSpans) {
			const expr = unwrap(span.expression);
			if (!ts.isConditionalExpression(expr) || !pushConditional(expr)) return null;
			parts.push(span.literal.text);
		}
	} else
		return null;

	if (conds.length > 3) return null;

	return {
		conds,
		build(mask, condList) {
			return parts.map(p => {
				if (typeof p === 'string') return p;
				const bit = condList.indexOf(conds[p.idx]);
				return (mask >> bit) & 1 ? p.yes : p.no;
			}).join('');
		}
	};
}

// `t(\`prefix.${name}\`, MAP[name])` where MAP is a literal object of strings:
// record one entry per key of MAP. Handles `MAP[name] || fallback` and
// `${name.toSnakeCase()}`.
function enumMapCall(keyTpl, phraseNode, call, where, applyPrefix) {
	if (keyTpl.templateSpans.length !== 1) return false;
	let span = unwrap(keyTpl.templateSpans[0].expression);
	let transform = s => s;
	if (ts.isCallExpression(span) && ts.isPropertyAccessExpression(span.expression) &&
		span.expression.name.text === 'toSnakeCase' && !span.arguments.length) {
		transform = toSnakeCase;
		span = unwrap(span.expression.expression);
	}
	if (!ts.isIdentifier(span)) return false;

	let phrase = unwrap(phraseNode);
	if (ts.isBinaryExpression(phrase) && phrase.operatorToken.kind === ts.SyntaxKind.BarBarToken)
		phrase = unwrap(phrase.left);
	if (!ts.isElementAccessExpression(phrase)) return false;
	const arg = unwrap(phrase.argumentExpression);
	if (!ts.isIdentifier(arg) || arg.text !== span.text) return false;
	const mapIdent = unwrap(phrase.expression);
	if (!ts.isIdentifier(mapIdent) || !RESOLVER) return false;

	const target = RESOLVER.resolveObject(mapIdent, 0);
	if (!target) return false;

	const head = keyTpl.head.text, tail = keyTpl.templateSpans[0].literal.text;
	let n = 0;
	for (const prop of target.node.properties) {
		if (!ts.isPropertyAssignment(prop)) continue;
		const name = propName(prop);
		const value = target.resolver.with(() => getString(prop.initializer));
		if (name === null || value === null) continue;
		record(applyPrefix(`${head}${transform(name)}${tail}`), value, where, 'enum-map');
		n++;
	}
	return n > 0;
}

// Collect `import NAME from './file.md'` declarations so markdown documents
// passed as phrases can be resolved.
function collectMarkdownImports(sf, file) {
	const out = new Map();
	for (const stmt of sf.statements) {
		if (!ts.isImportDeclaration(stmt) || !stmt.importClause || !stmt.importClause.name) continue;
		const spec = getString(stmt.moduleSpecifier);
		if (!spec || !spec.endsWith('.md')) continue;
		out.set(stmt.importClause.name.text, path.resolve(ROOT, path.dirname(file), spec));
	}
	return out;
}

// Link service: the `i18n_prefix: '...'` a response declares applies to every
// token key in it. Prefix declarations are collected per scope (method,
// function, class, file) so a file whose methods build responses with
// different prefixes still resolves each token against the right one.
const PREFIX_CACHE = new WeakMap(); // scope node -> Set of prefixes declared inside

function prefixesIn(scope, loc) {
	let found = PREFIX_CACHE.get(scope);
	if (found) return found;
	found = new Set();
	const visit = node => {
		if (ts.isPropertyAssignment(node)) {
			const name = propName(node);
			if (name === 'i18n_prefix' || name === 'i18n_token') {
				const val = getString(node.initializer);
				if (scope === loc.sf && name === 'i18n_token')
					diag('warn', 'typo', loc.at(node), `Property "i18n_token" is not read by the client; did you mean "i18n_prefix"? Treating it as the prefix.`);
				if (val !== null) found.add(val);
				else if (scope === loc.sf) diag('warn', 'dynamic-prefix', loc.at(node), `i18n_prefix is not a string literal: ${describeExpr(node.initializer)}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(scope);
	PREFIX_CACHE.set(scope, found);
	return found;
}

function isScopeNode(node) {
	return ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node) ||
		ts.isGetAccessorDeclaration(node) || ts.isSourceFile(node);
}

// Prefix for a token call: the innermost enclosing scope that declares a
// prefix wins. Returns the string, undefined when no scope declares one, or
// null when the innermost declaring scope is ambiguous.
function prefixForCall(call, loc) {
	// Make sure the file-level warnings fire once.
	prefixesIn(loc.sf, loc);
	for (let node = call.parent; node; node = node.parent) {
		if (!isScopeNode(node)) continue;
		const found = prefixesIn(node, loc);
		if (!found.size) continue;
		if (found.size === 1) return [...found][0];
		if (ts.isSourceFile(node))
			diag('warn', 'ambiguous-prefix', loc.at(call), `Token in a file with several i18n_prefix values (${[...found].join(', ')}) and no narrower scope declares one.`);
		return null;
	}
	return undefined;
}

// Resolve an identifier to the initializer of a `const`/`let` declared in an
// enclosing function scope, e.g. `const i18n_key = cond ? 'a' : 'b'`.
function resolveLocal(ident, from) {
	for (let scope = from.parent; scope; scope = scope.parent) {
		if (!isScopeNode(scope)) continue;
		let init = null;
		const visit = node => {
			if (init) return;
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === ident.text && node.initializer)
				init = node.initializer;
			else ts.forEachChild(node, visit);
		};
		visit(scope);
		if (init) return init;
		if (ts.isSourceFile(scope)) break;
	}
	return null;
}

function isNullish(node) {
	node = unwrap(node);
	return node && (node.kind === ts.SyntaxKind.NullKeyword ||
		(ts.isIdentifier(node) && node.text === 'undefined'));
}

// Evaluate a literal expression to a plain JS value. Returns {ok, value}.
function evalLiteral(node, depth = 0) {
	node = unwrap(node);
	if (!node || depth > 6) return { ok: false };

	const str = getString(node);
	if (str !== null) return { ok: true, value: str };

	if (ts.isNumericLiteral(node)) return { ok: true, value: Number(node.text) };
	if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand))
		return { ok: true, value: -Number(node.operand.text) };
	if (node.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
	if (node.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
	if (node.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
	if (ts.isIdentifier(node) && node.text === 'undefined') return { ok: true, value: undefined };

	if (ts.isArrayLiteralExpression(node)) {
		const out = [];
		for (const el of node.elements) {
			const r = evalLiteral(el, depth + 1);
			if (!r.ok) return { ok: false };
			out.push(r.value);
		}
		return { ok: true, value: out };
	}

	if (ts.isObjectLiteralExpression(node)) {
		const out = {};
		for (const prop of node.properties) {
			if (!ts.isPropertyAssignment(prop)) return { ok: false };
			const name = propName(prop);
			if (name === null) return { ok: false };
			const r = evalLiteral(prop.initializer, depth + 1);
			if (!r.ok) return { ok: false };
			out[name] = r.value;
		}
		return { ok: true, value: out };
	}

	return { ok: false };
}

function propName(prop) {
	const n = prop.name;
	if (!n) return null;
	if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
	if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
	return null;
}

// Find a property assignment on an object literal by name.
function getProp(obj, name) {
	if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
	for (const prop of obj.properties) {
		if (ts.isPropertyAssignment(prop) && propName(prop) === name)
			return prop.initializer;
		if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name)
			return prop.name;
		if (ts.isMethodDeclaration(prop) && propName(prop) === name)
			return prop;
	}
	return undefined;
}

function hasSpread(obj) {
	return obj.properties.some(p => ts.isSpreadAssignment(p));
}

function calleeName(call) {
	const c = unwrap(call.expression);
	if (ts.isIdentifier(c)) return c.text;
	if (ts.isPropertyAccessExpression(c)) return c.name.text;
	return null;
}

function calleeObjectText(call) {
	const c = unwrap(call.expression);
	if (ts.isPropertyAccessExpression(c)) return c.expression.getText();
	return '';
}


// ============================================================================
// Locations
// ============================================================================

class Locator {
	// `lineMap` maps a node position to a file line. For plain source files this
	// is the TS line map; for Vue templates we add the template's base line.
	constructor(file, sf, baseLine = 0) {
		this.file = file;
		this.sf = sf;
		this.baseLine = baseLine;
	}

	at(node) {
		const pos = node.getStart ? node.getStart(this.sf) : node.pos;
		const { line } = this.sf.getLineAndCharacterOfPosition(pos);
		return `${this.file}:${this.baseLine + line + 1}`;
	}
}


// ============================================================================
// Script Extraction
// ============================================================================

function extractFromScript(code, file, kind, baseLine = 0, opts = {}) {
	const sf = parseSource(code, file, kind);
	const loc = new Locator(file, sf, baseLine);
	const ctx = {
		sf, loc, file,
		expressionOnly: !!opts.expressionOnly,
		mdImports: opts.mdImports ?? (opts.expressionOnly ? new Map() : collectMarkdownImports(sf, file)),
		prefixed: IS_LINK_SERVICE && !opts.expressionOnly
	};

	if (opts.expressionOnly) {
		// Vue template expressions: resolve against the component's <script>.
		const prev = RESOLVER;
		RESOLVER = opts.resolver ?? null;
		try { walk(sf, ctx); } finally { RESOLVER = prev; }
	} else {
		new Resolver(sf, file).with(() => walk(sf, ctx));
	}
	return sf;
}

function walk(node, ctx) {
	if (ts.isCallExpression(node))
		visitCall(node, ctx);
	else if (ts.isObjectLiteralExpression(node) && !ctx.expressionOnly)
		visitObjectLiteral(node, ctx);
	else if (ts.isArrayLiteralExpression(node) && !ctx.expressionOnly)
		visitArrayPair(node, ctx);

	ts.forEachChild(node, child => walk(child, ctx));
}

function visitCall(call, ctx) {
	const name = calleeName(call);
	if (!name) return;

	if (T_METHODS.has(name))
		return visitTCall(call, ctx);

	if (ctx.expressionOnly) return;

	if (T_LIKE_METHODS.has(name))
		return visitTCall(call, ctx);

	if (name === 'addUI')
		return visitSettingsAdd(call, ctx, true);

	if (name === 'add' && /settings$/i.test(calleeObjectText(call)))
		return visitSettingsAdd(call, ctx, false);

	if (name === 'addHighlightReason')
		return visitHighlightReason(call, ctx);
}

function visitTCall(call, ctx) {
	let [keyNode, phraseNode] = call.arguments;
	if (!keyNode) return;

	const where = ctx.loc.at(call);

	// Local `const key = ...` / `const phrase = ...` indirection.
	if (ts.isIdentifier(unwrap(keyNode))) keyNode = resolveLocal(unwrap(keyNode), call) ?? keyNode;
	if (phraseNode && ts.isIdentifier(unwrap(phraseNode))) phraseNode = resolveLocal(unwrap(phraseNode), call) ?? phraseNode;

	// Link-service responses carry an `i18n_prefix`; the client prepends it to
	// every token key in that response. Mirror that here so keys match what the
	// client will look up.
	const prefix = ctx.prefixed ? prefixForCall(call, ctx.loc) : undefined;
	const applyPrefix = key => {
		if (prefix === undefined || prefix === null) return key;
		if (key.startsWith(`${prefix}.`)) {
			diag('warn', 'double-prefix', where, `Key "${key}" already carries the response's i18n_prefix "${prefix}"; the client will look up "${prefix}.${key}".`);
			return key;
		}
		if (/^(embed|card|clip|video)\./.test(key)) {
			diag('warn', 'double-prefix', where, `Absolute key "${key}" in a response with i18n_prefix "${prefix}"; the client will look up "${prefix}.${key}".`);
			return key;
		}
		return `${prefix}.${key}`;
	};

	let key = getString(keyNode);
	const phrase = phraseNode ? getString(phraseNode) : null;
	if (key !== null) key = applyPrefix(key);

	if (key === null) {
		// Dynamic key. If the phrase is also dynamic this is almost always the
		// metadata pattern t(item.i18n_key, item.title), handled elsewhere.
		const keyExpr = unwrap(keyNode);
		const isTemplate = ts.isTemplateExpression(keyExpr);
		if (!isTemplate && !ts.isConditionalExpression(keyExpr)) return;

		// `prefix${cond ? 'a' : 'b'}` or `cond ? 'a' : 'b'` with a matching
		// phrase: expand every branch.
		const keyTpl = conditionalTemplate(keyNode);
		const phraseTpl = phraseNode ? conditionalTemplate(phraseNode) : null;
		if (keyTpl && phraseTpl) {
			const conds = [...new Set([...keyTpl.conds, ...phraseTpl.conds])];
			if (conds.length <= 3) {
				for (let mask = 0; mask < (1 << conds.length); mask++)
					record(applyPrefix(keyTpl.build(mask, conds)), phraseTpl.build(mask, conds), where, 'call');
				return;
			}
		}

		// `prefix.${name}` with `MAP[name]` as the phrase, MAP a literal object:
		// one string per entry.
		if (isTemplate && phraseNode && enumMapCall(keyExpr, phraseNode, call, where, applyPrefix))
			return;

		if (!isTemplate) return;
		const head = keyExpr.head.text;
		const covered = COVERED_PREFIXES.some(p => head.startsWith(p));
		diag(covered ? 'info' : 'warn', 'dynamic-key', where,
			`Template-literal key ${describeExpr(keyNode)}` + (covered ? ' is covered by a registry handler.' : ' — ensure a registry handler covers it.'));
		return;
	}

	if (phrase === null) {
		if (!phraseNode) {
			diag('warn', 'missing-phrase', where, `t("${key}") called without a default phrase.`);
			return;
		}

		// A markdown document imported from a .md file, e.g. t('home.about', md).
		const ident = unwrap(phraseNode);
		if (ts.isIdentifier(ident) && ctx.mdImports.size) {
			let mdFile = ctx.mdImports.get(ident.text);
			if (!mdFile && ctx.mdImports.size === 1) {
				mdFile = [...ctx.mdImports.values()][0];
				diag('info', 'assumed-markdown', where, `Assuming "${ident.text}" in t("${key}") refers to the file's only markdown import, ${rel(mdFile)}.`);
			}
			if (mdFile) {
				if (fs.existsSync(mdFile))
					record(key, fs.readFileSync(mdFile, 'utf8'), where, 'markdown');
				else
					diag('error', 'missing-file', where, `t("${key}") refers to a missing markdown file ${rel(mdFile)}`);
				return;
			}
		}

		if (!isNullish(phraseNode))
			diag('warn', 'dynamic-phrase', where, `t("${key}", ${describeExpr(phraseNode)}) has a non-literal phrase.`);
		return;
	}

	record(key, phrase, where, 'call');
}


// ----------------------------------------------------------------------------
// Settings definitions
// ----------------------------------------------------------------------------

function visitSettingsAdd(call, ctx, isUI) {
	const [keyNode, defNode] = call.arguments;
	if (!defNode) return;

	const where = ctx.loc.at(call);
	const key = keyNode ? getString(keyNode) : null;
	const def = unwrap(defNode);

	if (!ts.isObjectLiteralExpression(def)) {
		diag('info', 'dynamic-setting', where, `${isUI ? 'addUI' : 'settings.add'}(${keyNode ? describeExpr(keyNode) : ''}) definition is not an object literal; run with runtime capture to cover it.`);
		return;
	}

	let ui = getProp(def, 'ui');
	if (ui) ui = unwrap(ui);
	if (!ui && isUI) ui = def;
	if (!ui) return; // Setting without UI: nothing to translate.

	if (!ts.isObjectLiteralExpression(ui)) {
		diag('info', 'dynamic-setting', where, `${isUI ? 'addUI' : 'settings.add'}(${key ?? describeExpr(keyNode)}) has a non-literal ui block.`);
		return;
	}

	if (hasSpread(ui))
		diag('info', 'dynamic-setting', where, `ui block for ${key ?? describeExpr(keyNode)} uses spread; some fields may be missed.`);

	if (key === null && keyNode) {
		const loses = getProp(ui, 'title') || getProp(ui, 'description');
		diag(loses ? 'warn' : 'info', 'dynamic-key', where,
			`${isUI ? 'addUI' : 'settings.add'}(${describeExpr(keyNode)}) has a dynamic key; ` +
			(loses ? 'its title/description cannot be keyed statically.' : 'it has no title or description, so only its path categories are extracted.'));
	}

	// Categories from the path.
	const pathNode = getProp(ui, 'path');
	if (pathNode) {
		const pathStr = getString(pathNode);
		if (pathStr === null)
			diag('warn', 'dynamic-key', where, `ui.path for ${key ?? '?'} is dynamic: ${describeExpr(pathNode)}`);
		else {
			let tokens;
			try {
				tokens = parsePath(pathStr);
			} catch (err) {
				diag('error', 'bad-path', where, `Cannot parse ui.path "${pathStr}": ${err.message}`);
				tokens = [];
			}

			let prefix = null;
			for (const tok of tokens) {
				const catKey = prefix ? `${prefix}.${tok.key}` : tok.key;
				record(`setting.${catKey}`, tok.title, where, 'category');
				if (typeof tok.description === 'string')
					record(`setting.${catKey}.description`, tok.description, where, 'category-description');
				prefix = catKey;
			}
		}
	}

	// Entry itself.
	const explicitKey = getProp(ui, 'i18n_key');
	let i18nKey = explicitKey ? getString(explicitKey) : null;
	if (explicitKey && i18nKey === null && !isNullish(explicitKey))
		diag('warn', 'dynamic-key', where, `ui.i18n_key for ${key ?? '?'} is dynamic.`);
	if (i18nKey === null && key !== null)
		i18nKey = `setting.entry.${key}`;
	if (i18nKey === null) return;

	const title = strProp(ui, 'title', ctx, where, `ui.title of ${key}`);
	if (title !== null) record(i18nKey, title, where, 'setting-title');

	const description = strProp(ui, 'description', ctx, where, `ui.description of ${key}`);
	if (description !== null) {
		const descKeyNode = getProp(ui, 'desc_i18n_key');
		const descKey = (descKeyNode && getString(descKeyNode)) || `${i18nKey}.description`;
		record(descKey, description, where, 'setting-description');
	}

	const pill = strProp(ui, 'pill', ctx, where, `ui.pill of ${key}`);
	if (pill !== null) {
		const pillKeyNode = getProp(ui, 'pill_i18n_key');
		const pillKey = pillKeyNode ? getString(pillKeyNode) : null;
		if (pillKey) record(pillKey, pill, where, 'setting-pill');
		else diag('info', 'untranslated', where, `ui.pill "${pill}" on ${key} has no pill_i18n_key and will not be translated.`);
	}

	// Markdown pages: <md-page> loads ../<key>.md and translates it as home.<key>.
	const component = getString(getProp(ui, 'component') ?? ts.factory.createNull());
	if (component === 'md-page') {
		const mdKey = getString(getProp(ui, 'key') ?? ts.factory.createNull());
		if (mdKey) {
			const mdFile = path.join(MD_DIR, `${mdKey}.md`);
			if (fs.existsSync(mdFile))
				record(`home.${mdKey}`, fs.readFileSync(mdFile, 'utf8'), `${rel(mdFile)}:1`, 'markdown');
			else
				diag('error', 'missing-file', where, `md-page "${mdKey}" refers to a missing file ${rel(mdFile)}`);
		}
	}

	// Select / combo box values. Only settings.add() applies this (settings/index.ts).
	if (!isUI && SELECT_COMPONENTS.has(component)) {
		const noI18n = getProp(ui, 'no_i18n');
		if (noI18n && evalLiteral(noI18n).value) return;

		const dataNode = getProp(ui, 'data');
		if (!dataNode) return;
		const data = unwrap(dataNode);
		if (!ts.isArrayLiteralExpression(data)) {
			diag('info', 'dynamic-data', where, `ui.data for ${key} is computed; its option titles need runtime capture.`);
			return;
		}

		const base = `${i18nKey}.values`;
		for (const el of data.elements) {
			const item = unwrap(el);
			if (!ts.isObjectLiteralExpression(item)) {
				diag('info', 'dynamic-data', ctx.loc.at(el), `ui.data item for ${key} is not an object literal.`);
				continue;
			}

			const itemTitle = getString(getProp(item, 'title') ?? ts.factory.createNull());
			if (itemTitle === null) {
				if (getProp(item, 'title'))
					diag('info', 'dynamic-data', ctx.loc.at(el), `ui.data item title for ${key} is dynamic.`);
				continue;
			}

			const itemKeyNode = getProp(item, 'i18n_key');
			let itemKey = itemKeyNode ? getString(itemKeyNode) : null;
			if (itemKey === null && !itemKeyNode) {
				const valNode = getProp(item, 'value');
				if (valNode) {
					const val = evalLiteral(valNode);
					if (val.ok && val.value !== undefined)
						itemKey = `${base}.${String(val.value)}`;
				}
			}

			if (itemKey) record(itemKey, itemTitle, ctx.loc.at(el), 'setting-value');
			else diag('info', 'untranslated', ctx.loc.at(el), `ui.data item "${itemTitle}" for ${key} has no derivable key.`);
		}
	}
}

// Read a string property, warning if it's present but dynamic.
function strProp(obj, name, ctx, where, label) {
	const node = getProp(obj, name);
	if (!node) return null;
	const val = getString(node);
	if (val === null && !ts.isMethodDeclaration(node) && !isNullish(node) &&
		!ts.isArrowFunction(unwrap(node)) && !ts.isFunctionExpression(unwrap(node)))
		diag('info', 'dynamic-phrase', where, `${label} is dynamic: ${describeExpr(node)}`);
	return val;
}


// ----------------------------------------------------------------------------
// Highlight reasons: addHighlightReason(key, title|data, label?)
// ----------------------------------------------------------------------------

function visitHighlightReason(call, ctx) {
	const [a, b, c] = call.arguments;
	if (!a) return;
	const where = ctx.loc.at(call);

	let key, data = null, title = null, label = null, i18nKey = null;
	const first = unwrap(a);

	if (ts.isObjectLiteralExpression(first)) {
		data = first;
		key = getString(getProp(data, 'key') ?? ts.factory.createNull());
	} else {
		key = getString(a);
		if (b) {
			const bn = unwrap(b);
			if (ts.isObjectLiteralExpression(bn)) data = bn;
			else title = getString(b);
		}
		if (c) label = getString(c);
	}

	if (key === null) {
		diag('warn', 'dynamic-key', where, `addHighlightReason(${describeExpr(a)}) has a dynamic key.`);
		return;
	}

	if (data) {
		title = title ?? getString(getProp(data, 'title') ?? ts.factory.createNull());
		label = label ?? getString(getProp(data, 'label') ?? ts.factory.createNull());
		i18nKey = getString(getProp(data, 'i18n_key') ?? ts.factory.createNull());
	}

	i18nKey = i18nKey ?? `hl-reason.${key}`;
	if (title !== null) record(i18nKey, title, where, 'highlight-reason');
	if (label !== null) {
		const labelKey = (data && getString(getProp(data, 'i18n_label') ?? ts.factory.createNull())) || `${i18nKey}.label`;
		record(labelKey, label, where, 'highlight-reason-label');
	}
}


// ----------------------------------------------------------------------------
// [key, phrase, data?] tuples (e.g. `return ['addon.deck.unset', '(Unset)']`
// consumed later as `t(...tuple)`)
// ----------------------------------------------------------------------------

function visitArrayPair(arr, ctx) {
	const els = arr.elements;
	if (els.length < 2 || els.length > 3) return;
	if (!ts.isStringLiteral(unwrap(els[0])) || !ts.isStringLiteral(unwrap(els[1]))) return;
	if (els[2] && !ts.isObjectLiteralExpression(unwrap(els[2])) && !ts.isIdentifier(unwrap(els[2]))) return;

	const key = getString(els[0]), phrase = getString(els[1]);
	if (!KEY_SHAPE.test(key) || KEY_SHAPE.test(phrase) || !/[A-Za-z]/.test(phrase)) return;

	// Only when the tuple is returned or assigned, not inside larger data arrays.
	const parent = arr.parent;
	if (!parent || !(ts.isReturnStatement(parent) || ts.isConditionalExpression(parent) ||
		ts.isVariableDeclaration(parent) || ts.isBinaryExpression(parent) || ts.isArrowFunction(parent)))
		return;

	record(key, phrase, ctx.loc.at(arr), 'array-pair');
}


// ----------------------------------------------------------------------------
// Generic metadata pairs on object literals
// ----------------------------------------------------------------------------

function visitObjectLiteral(obj, ctx) {
	// Rich content tokens: {type: 'i18n', key: '...', phrase: '...'} rendered
	// by utilities/rich_tokens.js through i18n.tList(key, phrase, content).
	const typeNode = getProp(obj, 'type');
	if (typeNode && getString(typeNode) === 'i18n') {
		const key = getString(getProp(obj, 'key') ?? ts.factory.createNull());
		const phrase = getString(getProp(obj, 'phrase') ?? ts.factory.createNull());
		if (key !== null && phrase !== null) record(key, phrase, ctx.loc.at(obj), 'rich-token');
		else if (key !== null) diag('warn', 'dynamic-phrase', ctx.loc.at(obj), `Rich i18n token "${key}" has a non-literal phrase.`);
	}

	for (const [i18nProp, textProps] of META_PAIRS) {
		const keyNode = getProp(obj, i18nProp);
		if (!keyNode) continue;
		const key = getString(keyNode);
		if (key === null) continue;

		for (const textProp of textProps) {
			const textNode = getProp(obj, textProp);
			if (!textNode) continue;
			const text = getString(textNode);
			if (text === null) continue;
			record(key, text, ctx.loc.at(obj), 'metadata');

			// `{i18n_key, title, description}` without desc_i18n_key implies
			// `${i18n_key}.description` (profiles, settings tree, providers).
			if (i18nProp === 'i18n_key' && !getProp(obj, 'desc_i18n_key')) {
				const descNode = getProp(obj, 'description');
				const desc = descNode ? getString(descNode) : null;
				if (desc !== null) record(`${key}.description`, desc, ctx.loc.at(obj), 'metadata');
			}
			break;
		}
	}
}


// ============================================================================
// Vue Single File Components
// ============================================================================

function extractFromVue(code, file) {
	const sfc = compiler.parseComponent(code, { pad: 'line' });

	let mdImports = new Map(), resolver = null;
	if (sfc.script && sfc.script.content) {
		const lang = sfc.script.lang || (sfc.script.attrs && sfc.script.attrs.lang);
		const sf = extractFromScript(sfc.script.content, file, scriptKindFor(file, lang));
		mdImports = collectMarkdownImports(sf, file);
		resolver = new Resolver(sf, file);
	}

	if (sfc.template && sfc.template.content) {
		const baseLine = lineOf(code, sfc.template.start);
		let compiled;
		try {
			compiled = compiler.compile(sfc.template.content, { outputSourceRange: true, whitespace: 'condense' });
		} catch (err) {
			diag('error', 'vue-compile', `${file}:${baseLine + 1}`, `Template failed to compile: ${err.message}`);
			return;
		}
		for (const e of compiled.errors || [])
			diag('warn', 'vue-compile', `${file}:${baseLine + 1}`, typeof e === 'string' ? e : e.msg);

		if (compiled.ast)
			walkVueNode(compiled.ast, { file, template: sfc.template.content, baseLine, mdImports, resolver }, new Set());
	}
}

function lineOf(code, offset) {
	let n = 0;
	for (let i = 0; i < offset && i < code.length; i++)
		if (code.charCodeAt(i) === 10) n++;
	return n;
}

function walkVueNode(node, vctx, seen) {
	if (!node || seen.has(node)) return;
	seen.add(node);

	if (node.type === 1) {
		const where = vueLoc(vctx, node.start);

		if (node.tag === 't-list') {
			const attrs = node.attrsMap || {};
			const phrase = attrs.phrase, def = attrs.default;
			if (typeof phrase === 'string' && typeof def === 'string')
				record(phrase, def, where, 't-list');
			else
				diag('warn', 'dynamic-key', where, `<t-list> with bound phrase/default (${Object.keys(attrs).filter(k => /phrase|default/.test(k)).join(', ')}).`);
		}

		for (const attr of node.attrsList || []) {
			const name = attr.name;
			if (!/^(?::|v-bind:|v-|@|#)/.test(name)) continue;
			if (/^(v-slot|#|v-else$|v-pre|v-cloak|v-once)/.test(name)) continue;

			let expr = attr.value;
			if (!expr) continue;
			if (name === 'v-for') {
				const m = /\s(?:in|of)\s+([\s\S]+)$/.exec(expr);
				if (!m) continue;
				expr = m[1];
			}
			extractVueExpression(expr, vctx, attr.start ?? node.start);
		}

		for (const child of node.children || [])
			walkVueNode(child, vctx, seen);

		if (node.ifConditions)
			for (const cond of node.ifConditions)
				if (cond.block && cond.block !== node) walkVueNode(cond.block, vctx, seen);

		if (node.scopedSlots)
			for (const slot of Object.values(node.scopedSlots))
				walkVueNode(slot, vctx, seen);

	} else if (node.type === 2 && Array.isArray(node.tokens)) {
		for (const tok of node.tokens)
			if (tok && typeof tok === 'object' && tok['@binding'])
				extractVueExpression(tok['@binding'], vctx, node.start);
	}
}

function extractVueExpression(expr, vctx, offset) {
	const baseLine = vueLine(vctx, offset);
	extractFromScript(`(${expr}\n)`, vctx.file, ts.ScriptKind.TS, baseLine, { expressionOnly: true, mdImports: vctx.mdImports, resolver: vctx.resolver });
}

function vueLine(vctx, offset) {
	if (typeof offset !== 'number') return vctx.baseLine;
	return vctx.baseLine + lineOf(vctx.template, offset);
}

function vueLoc(vctx, offset) {
	return `${vctx.file}:${vueLine(vctx, offset) + 1}`;
}


// ============================================================================
// Registries: prefix + enum-key patterns backed by literal maps
// ============================================================================

// Find a top-level `const NAME = {...}` / `export const NAME = {...}`.
function findTopLevelObject(sf, name) {
	for (const stmt of sf.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		for (const decl of stmt.declarationList.declarations) {
			if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
				const init = unwrap(decl.initializer);
				if (ts.isObjectLiteralExpression(init)) return init;
			}
		}
	}
	return null;
}

function exportedObjects(sf) {
	const out = [];
	for (const stmt of sf.statements) {
		if (!ts.isVariableStatement(stmt)) continue;
		const exported = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
		if (!exported) continue;
		for (const decl of stmt.declarationList.declarations) {
			if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
			const init = unwrap(decl.initializer);
			if (ts.isObjectLiteralExpression(init)) out.push([decl.name.text, init]);
		}
	}
	return out;
}

function eachStringProp(obj, fn) {
	for (const prop of obj.properties) {
		if (!ts.isPropertyAssignment(prop)) continue;
		const name = propName(prop);
		const val = getString(prop.initializer);
		if (name !== null && val !== null) fn(name, val, prop);
	}
}

const REGISTRIES = {
	// chat.filtering.automod.<flag>
	'src/modules/chat/tokenizers.jsx'(sf, loc) {
		const obj = findTopLevelObject(sf, 'AM_DESCRIPTIONS');
		if (!obj) return diag('error', 'registry', rel(sf.fileName), 'AM_DESCRIPTIONS not found.');
		eachStringProp(obj, (k, v, p) => record(`chat.filtering.automod.${k}`, v, loc.at(p), 'registry'));
	},

	// emoji.category.<snake_case>
	'src/modules/chat/emoji.js'(sf, loc) {
		const obj = findTopLevelObject(sf, 'CATEGORIES');
		if (!obj) return diag('error', 'registry', rel(sf.fileName), 'CATEGORIES not found.');
		eachStringProp(obj, (k, v, p) => record(`emoji.category.${toSnakeCase(k)}`, v, loc.at(p), 'registry'));
	},

	// setting.clear.opt.<ExportName>
	'src/settings/clearables.ts'(sf, loc) {
		for (const [name, obj] of exportedObjects(sf)) {
			const label = getString(getProp(obj, 'label') ?? ts.factory.createNull());
			if (label !== null) record(`setting.clear.opt.${name}`, label, loc.at(obj), 'registry');
		}
	},

	// setting.provider.<id>.title / .desc from static class fields.
	'src/settings/providers.ts'(sf, loc) {
		const map = findTopLevelObject(sf, 'Providers');
		if (!map) return diag('error', 'registry', rel(sf.fileName), 'Providers map not found.');

		const classes = new Map();
		for (const stmt of sf.statements)
			if (ts.isClassDeclaration(stmt) && stmt.name) classes.set(stmt.name.text, stmt);

		for (const prop of map.properties) {
			if (!ts.isPropertyAssignment(prop)) continue;
			const id = propName(prop);
			const init = unwrap(prop.initializer);
			if (id === null || !ts.isIdentifier(init)) continue;
			const cls = classes.get(init.text);
			if (!cls) { diag('warn', 'registry', loc.at(prop), `Provider class ${init.text} not found.`); continue; }

			for (const member of cls.members) {
				if (!ts.isPropertyDeclaration(member) || !member.initializer) continue;
				const isStatic = member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword);
				if (!isStatic) continue;
				const name = propName(member);
				const val = getString(member.initializer);
				if (val === null) continue;
				if (name === 'title') record(`setting.provider.${id}.title`, val, loc.at(member), 'registry');
				else if (name === 'description') record(`setting.provider.${id}.desc`, val, loc.at(member), 'registry');
			}
		}
	},

	// chat.actions.<name> (+ .desc) unless title_i18n / description_i18n override.
	'src/modules/chat/actions/types.jsx': chatActionRegistry,
	'src/modules/chat/actions/renderers.jsx': chatActionRegistry
};

function chatActionRegistry(sf, loc) {
	for (const [name, obj] of exportedObjects(sf)) {
		const where = loc.at(obj);

		const titleNode = getProp(obj, 'title');
		const title = titleNode ? getString(titleNode) : null;
		const titleKeyNode = getProp(obj, 'title_i18n');
		if (title !== null) {
			const titleKey = titleKeyNode ? getString(titleKeyNode) : `chat.actions.${name}`;
			if (titleKey) record(titleKey, title, where, 'chat-action');
		} else if (titleNode)
			diag('info', 'dynamic-phrase', where, `Chat action "${name}" has a computed title.`);

		const descNode = getProp(obj, 'description');
		const desc = descNode ? getString(descNode) : null;
		const descKeyNode = getProp(obj, 'description_i18n');
		if (desc !== null) {
			if (descKeyNode && isNullish(descKeyNode)) continue;
			const descKey = descKeyNode ? getString(descKeyNode) : `chat.actions.${name}.desc`;
			if (descKey) record(descKey, desc, where, 'chat-action');
		}
	}
}


// ============================================================================
// ICU validation and variable extraction
// ============================================================================

function icuVariables(ast, out = new Set()) {
	if (Array.isArray(ast)) {
		for (const n of ast) icuVariables(n, out);
		return out;
	}
	if (ast && typeof ast === 'object') {
		if (ast.v) out.add(ast.v);
		if (ast.o) for (const sub of Object.values(ast.o)) icuVariables(sub, out);
		if (ast.c) icuVariables(ast.c, out);
	}
	return out;
}


// ============================================================================
// Main
// ============================================================================

function rel(file) {
	return path.relative(ROOT, file).split(path.sep).join('/');
}

function main() {
	const files = globSync(SOURCE_GLOB, {
		cwd: ROOT, ignore: IGNORE, nodir: true, posix: true
	}).sort();

	for (const file of files) {
		const abs = path.join(ROOT, file);
		const code = fs.readFileSync(abs, 'utf8');

		try {
			if (file.endsWith('.vue'))
				extractFromVue(code, file);
			else {
				const sf = extractFromScript(code, file, scriptKindFor(file));
				const registry = REGISTRIES[file];
				if (registry) registry(sf, new Locator(file, sf));
			}
		} catch (err) {
			diag('error', 'exception', file, `Extractor crashed: ${err.stack || err}`);
		}
	}

	// Registries whose files were not scanned at all.
	for (const file of Object.keys(REGISTRIES))
		if (!files.includes(file))
			diag(IS_CORE ? 'error' : 'info', 'registry', file, 'Registry source file not found.');

	// Resolve conflicts and build output.
	const strings = {};
	const meta = {};
	let conflicts = 0;

	for (const key of [...entries.keys()].sort()) {
		const entry = entries.get(key);
		const variants = [...entry.phrases.entries()].sort((a, b) => b[1].size - a[1].size);
		const [phrase, calls] = variants[0];

		if (variants.length > 1) {
			conflicts++;
			diag('error', 'conflict', [...calls][0],
				`Key "${key}" has ${variants.length} different default phrases:\n` +
				variants.map(([p, c]) => `      ${JSON.stringify(p)}\n        at ${[...c].join(', ')}`).join('\n'));
		}

		let variables = [];
		try {
			variables = [...icuVariables(icu.parse(phrase))].sort();
		} catch (err) {
			diag('error', 'icu', [...calls][0], `Phrase for "${key}" fails to parse as ICU MessageFormat: ${err.message}`);
		}

		const allCalls = [...new Set(variants.flatMap(([, c]) => [...c]))].sort();
		strings[key] = phrase;
		meta[key] = {
			phrase,
			variables,
			kinds: [...entry.kinds].sort(),
			calls: allCalls,
			// Top-level src/ directories using this key. For add-ons, the
			// directory name is the add-on id and therefore its locale chunk.
			dirs: [...new Set(allCalls.map(c => {
				const parts = c.split(':')[0].split('/');
				return parts[0] === 'src' && parts.length > 2 ? parts[1] : '';
			}).filter(Boolean))].sort(),
			conflict: variants.length > 1 ? variants.map(([p, c]) => ({ phrase: p, calls: [...c].sort() })) : undefined
		};
	}

	fs.mkdirSync(OUT_DIR, { recursive: true });
	fs.writeFileSync(path.join(OUT_DIR, 'strings.json'), JSON.stringify(strings, null, '\t') + '\n');

	// Per top-level directory output (one file per add-on in the add-ons repo).
	if (ARGS.byDir) {
		const groups = {};
		for (const [key, m] of Object.entries(meta)) {
			const dirs = new Set(m.calls.map(c => {
				const parts = c.split(':')[0].split('/');
				return parts[0] === 'src' && parts.length > 2 ? parts[1] : '_root';
			}));
			for (const dir of dirs)
				(groups[dir] = groups[dir] || {})[key] = m.phrase;
		}
		for (const [dir, group] of Object.entries(groups))
			fs.writeFileSync(path.join(OUT_DIR, `strings.${dir}.json`), JSON.stringify(group, null, '\t') + '\n');
		console.log(`Wrote ${Object.keys(groups).length} per-directory files.`);
	}

	if (ARGS.webext) {
		const webext = {};
		for (const [key, m] of Object.entries(meta)) {
			const notes = [];
			if (m.variables.length) notes.push(`Variables: ${m.variables.join(', ')}`);
			if (m.kinds.includes('markdown') || m.kinds.includes('setting-description')) notes.push('Markdown is allowed.');
			notes.push(`Used at: ${m.calls.slice(0, 3).join(', ')}${m.calls.length > 3 ? ` (+${m.calls.length - 3} more)` : ''}`);
			webext[key] = { message: m.phrase, description: notes.join(' | ') };
		}
		fs.writeFileSync(path.join(OUT_DIR, 'strings.webext.json'), JSON.stringify(webext, null, '\t') + '\n');
	}

	const levels = { error: 0, warn: 0, info: 0 };
	for (const d of diagnostics) levels[d.level]++;

	fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify({
		generated: new Date().toISOString(),
		repo: REPO,
		root: ROOT,
		files_scanned: files.length,
		strings: Object.keys(strings).length,
		conflicts,
		diagnostics: levels,
		entries: meta,
		issues: diagnostics
	}, null, '\t') + '\n');

	// Report.
	if (!ARGS.quiet) {
		const order = { error: 0, warn: 1, info: 2 };
		const sorted = [...diagnostics].sort((a, b) => order[a.level] - order[b.level] || a.loc.localeCompare(b.loc));
		for (const d of sorted)
			if (d.level !== 'info')
				console.log(`[${d.level}] ${d.type} ${d.loc}\n    ${d.message}`);
	}

	const kindCounts = {};
	for (const m of Object.values(meta))
		for (const k of m.kinds) kindCounts[k] = (kindCounts[k] || 0) + 1;

	console.log(`\nScanned ${files.length} files in ${REPO} repository. Extracted ${Object.keys(strings).length} strings to ${path.relative(process.cwd(), OUT_DIR) || '.'}/`);
	console.log('By kind: ' + Object.entries(kindCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
	console.log(`Diagnostics: ${levels.error} errors, ${levels.warn} warnings, ${levels.info} info (see meta.json)`);

	if (ARGS.strict && levels.error > 0) {
		console.error('\nStrict mode: failing due to errors.');
		process.exit(1);
	}
}

main();
