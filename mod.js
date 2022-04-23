import { parse } from 'https://deno.land/std@0.136.0/encoding/yaml.ts';
import * as nodeResolver from 'https://cdn.jsdelivr.net/gh/lukeed/resolve.exports@1.1.0/src/index.js';

const options = {
	includeDependencies: true,
	includeDevDependencies: true,
	includeOptionalDependencies: false,
};

const decoder = new TextDecoder('utf-8');

const buffer = await Deno.readFile('test/pnpm-lock.yaml');
const source = decoder.decode(buffer);

const JSDELIVR_CDN = (pkg, version, path = '') => {
	return `https://cdn.jsdelivr.net/npm/${pkg}@${version}/${path}`;
}

const JSDELIVR_LISTING = (pkg, version) => {
	return `https://data.jsdelivr.com/v1/package/npm/${pkg}@${version}`;
};

const lock = parse(source);

const queue = [];
const dependencies = {};
const cache = {};
const importmap = { imports: {}, scopes: {} };

const fetchPkgMeta = async (pkg, actualver) => {
	const url = JSDELIVR_CDN(pkg, actualver, 'package.json');
	console.log('%cFetching', 'color: green', url);

	const response = await fetch(url);
	const meta = await response.json();

	return meta;
};

const fetchJsDelivrListing = async (pkg, actualver) => {
	const url = JSDELIVR_LISTING(pkg, actualver);
	console.log(`%cFetching`, 'color: green', url);

	const response = await fetch(url);
	const listing = await response.json();

	return flattenJsDelivrListing(listing.files);
};

const flattenJsDelivrListing = (files) => {
	const set = new Set();

	const flatten = (files, prev) => {
		for (const node of files) {
			if (node.type === 'directory') {
				flatten(node.files, `${prev}${node.name}/`);
			}
			else {
				set.add(`${prev}${node.name}`);
			}
		}
	};

	flatten(files, '');
	return set;
};

const write = async (pkg, ver, target) => {
	const actualver = ver.replace(/_(.*)$/, '');

	const lockKey = `/${pkg}/${ver}`;
	const scopeKey = JSDELIVR_CDN(pkg, actualver);

	if (cache[scopeKey]) {
		console.log('%cCached', 'color: yellow', `${pkg}@${actualver}`);

		if (target === importmap.imports || dependencies[pkg] !== ver) {
			Object.assign(target, cache[scopeKey]);
		}

		return;
	}

	console.log('%cResolving', 'color: blue', `${pkg}@${actualver}`);

	const def = cache[scopeKey] = {};
	const scope = {};

	const lockmeta = lock.packages[lockKey];
	const meta = await fetchPkgMeta(pkg, actualver);

	if (meta.exports) {
		if (typeof meta.exports === 'string') {
			const resolved = meta.exports;
			const url = JSDELIVR_CDN(pkg, actualver, resolved.slice(2));

			def[pkg] = url;
		}
		else {
			let isSingular = false;

			for (const key in meta.exports) {
				isSingular = key[0] !== '.';
				break;
			}

			if (isSingular) {
				const resolved = nodeResolver.resolve(meta, '.', { conditions: ['module'] });
				const url = JSDELIVR_CDN(pkg, actualver, resolved.slice(2));

				def[pkg] = url;
			}
			else {
				for (const key in meta.exports) {
					const pkgkey = key.replace('.', pkg);

					if (key.endsWith('/*')) {
						const actualkey = pkgkey.slice(0, -1);
						const value = key[value];

						const resolved = value.replace('.', pkg).replace(/\*(\..+)?$/, '');
						const url = JSDELIVR_CDN(pkg, actualver, resolved);

						def[actualkey] = url;
						continue;
					}

					const resolved = nodeResolver.resolve(meta, key, { conditions: ['module'] });
					const url = JSDELIVR_CDN(pkg, actualver, resolved.slice(2));

					def[pkgkey] = url;
				}
			}
		}
	}
	else {
		// main entrypoint can point to files without their extension
		const files = await fetchJsDelivrListing(pkg, actualver);
		const fields = ['module', 'main'];
		const order = ['', '.mjs', '.js', '.json'];

		let entry;

		for (const field of fields) {
			const value = meta[field];

			if (typeof value === 'string') {
				entry = value.replace(/^\.?\//, '');
				break;
			}
		}

		let hasResolved = false;

		if (entry) {
			for (const ext of order) {
				const resolved = `${entry}${ext}`;

				if (files.has(resolved)) {
					def[pkg] = JSDELIVR_CDN(pkg, actualver, resolved);
					hasResolved = true;
					break;
				}
			}
		}

		if (!hasResolved) {
			entry = 'index.js';

			for (const ext of order) {
				const resolved = `${entry}${ext}`;

				if (files.has(resolved)) {
					def[pkg] = JSDELIVR_CDN(pkg, actualver, resolved);
					hasResolved = true;
					break;
				}
			}
		}

		def[`${pkg}/`] = JSDELIVR_CDN(pkg, actualver);
	}

	const dependents = { ...lockmeta.optionalDependencies, ...lockmeta.dependencies };

	if (dependents) {
		for (const pkg in dependents) {
			const ver = dependents[pkg];

			queue.push([pkg, ver, scope]);
		}
	}

	Object.assign(target, cache[scopeKey]);
	importmap.scopes[scopeKey] = scope;
};


if (options.includeDevDependencies) {
	Object.assign(dependencies, lock.devDependencies);
}

if (options.includeOptionalDependencies) {
	Object.assign(dependencies, lock.optionalDependencies);
}

if (options.includeDependencies) {
	Object.assign(dependencies, lock.dependencies);
}

for (const pkg in dependencies) {
	const ver = dependencies[pkg];
	const imports = importmap.imports;

	queue.push([pkg, ver, imports]);
}

for (const [pkg, ver, scope] of queue) {
	await write(pkg, ver, scope);
}

for (const key in importmap.scopes) {
	const scope = importmap.scopes[key];
	let empty = true;

	for (const _ in scope) {
		empty = false;
		break;
	}

	if (empty) {
		delete importmap.scopes[key];
	}
}

console.log(JSON.stringify(importmap, null, 2));
