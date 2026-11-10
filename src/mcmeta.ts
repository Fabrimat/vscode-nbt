import envPaths from 'env-paths'
import path from 'path'
import { Writable } from 'stream'
import { Parser } from 'tar'
import type { Logger } from './common/types'
import type { Job } from './Downloader'
import { Downloader } from './Downloader'

const MCMETA = 'https://raw.githubusercontent.com/misode/mcmeta'
const FALLBACK_VERSION = '1.18.2'

const cacheRoot = envPaths('vscode-nbt').cache
export const mcmetaRoot = path.join(cacheRoot, 'mcmeta')

interface McmetaVersion {
	id: string,
	name: string,
	release_target: string,
	type: 'release' | 'snapshot',
	stable: boolean,
	data_version: number,
	protocol_version: number,
	data_pack_version: number,
	resource_pack_version: number,
	build_time: string,
	release_time: string,
	sha1: string
}

const assetsMemo = new Map<string, Promise<{ version: string }>>()
let versionsRefresh: Promise<McmetaVersion[] | undefined> | undefined

/**
 * Resolves to the assets of the version matching `dataVersion`, downloading what is not cached yet.
 * Results are memoized for the session, so reopening files does no disk or network work.
 */
export function getAssets(dataVersion: number | undefined, logger: Logger) {
	const key = String(dataVersion)
	let promise = assetsMemo.get(key)
	if (!promise) {
		promise = loadAssets(dataVersion, logger)
		assetsMemo.set(key, promise)
		promise.catch(() => assetsMemo.delete(key))
	}
	return promise
}

async function loadAssets(dataVersion: number | undefined, logger: Logger) {
	const downloader = new Downloader(mcmetaRoot, logger)

	const downloadVersions = (refresh: boolean) => downloader.download<McmetaVersion[]>({
		id: 'versions',
		uri: `${MCMETA}/summary/versions/data.min.json`,
		transformer: data => JSON.parse(data.toString('utf-8')),
		cache: cacheOptions(undefined, refresh),
	})
	// A cached list is used right away; it is refreshed in the background once per session.
	let versions = await downloadVersions(false)
	versionsRefresh ??= downloadVersions(true)
	if (dataVersion !== undefined && !versions?.some(v => v.data_version === dataVersion)) {
		// Unknown to the cached list (e.g. a new snapshot), so wait for the refresh.
		versions = await versionsRefresh ?? versions
	}
	const target = dataVersion ?? versions?.find(v => v.type === 'release')?.data_version
	const version = versions?.find(v => v.data_version === target)?.id ?? FALLBACK_VERSION
	if (!/^[\w.\-]+$/.test(version)) {
		throw new Error(`Invalid version id: ${version}`)
	}
	logger.info(`Found matching version for ${target}: ${version}`)

	const [blocks, atlas, uvmapping, assets] = await Promise.all([
		downloader.download({
			id: `${version}-blocks`,
			uri: `${MCMETA}/${version}-summary/blocks/data.min.json`,
			transformer: () => true,
			cache: cacheOptions(data => stringifiedScript('stringifiedBlocks', data.toString('utf-8'))),
		}),
		downloader.download({
			id: `${version}-atlas`,
			uri: `${MCMETA}/${version}-atlas/all/atlas.png`,
			transformer: () => true,
			cache: cacheOptions(),
		}),
		downloader.download({
			id: `${version}-uvmapping`,
			uri: `${MCMETA}/${version}-atlas/all/data.min.json`,
			transformer: () => true,
			cache: cacheOptions(data => stringifiedScript('stringifiedUvmapping', data.toString('utf-8'))),
		}),
		downloader.download({
			id: `${version}-assets`,
			uri: `https://github.com/misode/mcmeta/tarball/${version}-assets-json`,
			transformer: data => data,
			cache: cacheOptions(async data => {
				const entries = await readTarGz(data, (path: string) => {
					return path.includes('/assets/minecraft/models/')
						|| path.includes('/assets/minecraft/blockstates/')
				})
				const filterEntries = (type: string) => {
					const pattern = RegExp(`/assets/minecraft/${type}/([a-z0-9/_]+)\\.json`)
					return Object.fromEntries(entries.flatMap<[string, unknown]>(({ path, data }) => {
						const match = path.match(pattern)
						return match ? [[match[1], JSON.parse(data)]] : []
					}))
				}
				const blockstates = filterEntries('blockstates')
				const models = filterEntries('models')
				return stringifiedScript('stringifiedAssets', JSON.stringify({ blockstates, models }))
			}),
		}),
	])

	if (!blocks || !atlas || !uvmapping || !assets) {
		throw new Error('Failed loading assets')
	}

	return {
		version,
	}
}

function cacheOptions(serializer?: (data: Buffer) => Buffer | Promise<Buffer>, refresh = false): Job<unknown>['cache'] {
	// Every id is version-specific (or, for the versions list, refreshed explicitly),
	// so a cached file is used as is without a network round-trip.
	return { serializer, refresh }
}

/**
 * Emits a script defining `name` as a string holding the JSON `text`, which the webview JSON.parses.
 * @throws If `text` is not valid JSON.
 */
function stringifiedScript(name: string, text: string) {
	JSON.parse(text)
	return Buffer.from(`const ${name} = ${JSON.stringify(text)}`)
}

interface TarEntry {
	path: string,
	data: string,
}

function readTarGz(buffer: Buffer, filter: (path: string) => boolean = (() => true)) {
	const entries: TarEntry[] = []
	const pending: Promise<void>[] = []
	return new Promise<TarEntry[]>((res, rej) => {
		const parser = new Parser()
		parser
			.on('error', err => rej(err))
			.on('entry', entry => {
				if (filter(entry.path)) {
					const chunks: Buffer[] = []
					pending.push(new Promise<void>((done, fail) => {
						entry.on('error', fail)
						entry.pipe(new Writable({
							write(chunk, _, next) {
								chunks.push(chunk)
								next()
							},
							final(callback) {
								entries.push({ path: entry.path, data: Buffer.concat(chunks).toString('utf-8') })
								callback()
								done()
							},
						}))
					}))
				} else {
					entry.resume()
				}
			})
			.on('end', () => {
				Promise.all(pending).then(() => res(entries), rej)
			})
		parser.end(buffer)
	})
}
