/**
 * Downloader from Spyglass
 * MIT License
 * Copyright (c) 2019-2022 SPGoding
 */
import { http, https } from 'follow-redirects'
import { promises as fsp } from 'fs'
import type { IncomingMessage } from 'http'
import path from 'path'
import type { Logger } from './common/types'
import { fileUtil, isEnoent, promisifyAsyncIterable } from './fileUtil'

type RemoteProtocol = 'http:' | 'https:'
export type RemoteUriString = `${RemoteProtocol}${string}`
export namespace RemoteUriString {
	export function getProtocol(uri: RemoteUriString): RemoteProtocol {
		return uri.slice(0, uri.indexOf(':') + 1) as RemoteProtocol
	}
}

export interface DownloaderDownloadOut {
	cachePath?: string,
}

/**
 * In-flight cached downloads, so documents opened at the same time share one download.
 */
const inFlight = new Map<string, Promise<unknown>>()

/**
 * Writes to a temp file and renames it, so a crash never leaves a truncated file behind.
 */
async function writeFileAtomic(filePath: string, data: Buffer | string) {
	const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
	try {
		await fileUtil.writeFile(fileUtil.pathToFileUri(tmp), data)
		await fsp.rename(tmp, filePath)
	} catch (e) {
		await fsp.unlink(tmp).catch(() => { })
		throw e
	}
}

export class Downloader {
	constructor(
		private readonly cacheRoot: string,
		private readonly logger: Logger,
		private readonly lld = LowLevelDownloader.create(),
	) { }

	download<R>(job: Job<R>, out: DownloaderDownloadOut = {}): Promise<R | undefined> {
		if (!job.cache) {
			return this.doDownload(job, out)
		}
		const key = path.join(this.cacheRoot, job.id)
		let promise = inFlight.get(key) as Promise<R | undefined> | undefined
		if (!promise) {
			promise = this.doDownload(job, out).finally(() => inFlight.delete(key))
			inFlight.set(key, promise)
		}
		return promise
	}

	private async doDownload<R>(job: Job<R>, out: DownloaderDownloadOut): Promise<R | undefined> {
		const { id, cache, uri, options, transformer } = job
		let cachePath: string | undefined
		if (cache) {
			out.cachePath = cachePath = path.join(this.cacheRoot, id)
			if (!cache.refresh) {
				// The id is specific to a version, so a cached file never goes stale and needs no network round-trip.
				try {
					const cachedBuffer = await fileUtil.readFile(fileUtil.pathToFileUri(cachePath))
					const deserializer = cache.deserializer ?? (b => b)
					return await transformer(await deserializer(cachedBuffer))
				} catch (e) {
					if (!isEnoent(e)) {
						this.logger.error(`[Downloader] [${id}] Loading cached file “${cachePath}”`, e)
					}
				}
			}
		}

		try {
			const buffer = await this.lld.get(uri, options)
			if (cache && cachePath) {
				// The webview loads these files directly, so a failed serialization or write is a failed download.
				const serializer = cache.serializer ?? (b => b)
				await writeFileAtomic(cachePath, await serializer(buffer))
			}
			this.logger.info(`[Downloader] [${id}] Downloaded from “${uri}”`)
			return await transformer(buffer)
		} catch (e) {
			this.logger.error(`[Downloader] [${id}] Downloading “${uri}”`, e)
			if (cache && cachePath) {
				try {
					const cachedBuffer = await fileUtil.readFile(fileUtil.pathToFileUri(cachePath))
					const deserializer = cache.deserializer ?? (b => b)
					const ans = await transformer(await deserializer(cachedBuffer))
					this.logger.warn(`[Downloader] [${id}] Fell back to cached file “${cachePath}”`)
					return ans
				} catch (e) {
					this.logger.error(`[Downloader] [${id}] Fallback: loading cached file “${cachePath}”`, e)
				}
			}
		}

		return undefined
	}
}

export interface Job<R> {
	/**
	 * A unique ID for the cache.
	 * 
	 * It also determines where the file is cached. Use slashes (`/`) to create directories.
	 */
	id: string,
	uri: RemoteUriString,
	cache?: {
		/**
		 * Skip the cached file and download, still writing the result to the cache.
		 */
		refresh?: boolean,
		serializer?: (data: Buffer) => Buffer | Promise<Buffer>,
		deserializer?: (cache: Buffer) => Buffer | Promise<Buffer>,
	},
	transformer: (data: Buffer) => PromiseLike<R> | R,
	options?: LowLevelDownloadOptions,
}

interface LowLevelDownloadOptions {
	/**
	 * Use an string array to set multiple values to the header.
	 */
	headers?: Record<string, string | string[]>
	timeout?: number,
}

export interface LowLevelDownloader {
	/**
	 * @throws
	 */
	get(uri: RemoteUriString, options?: LowLevelDownloadOptions): Promise<Buffer>
}

export namespace LowLevelDownloader {
	export function create(): LowLevelDownloader {
		return new LowLevelDownloaderImpl()
	}
	export function mock(options: LowLevelDownloaderMockOptions): LowLevelDownloader {
		return new LowLevelDownloaderMock(options)
	}
}

class LowLevelDownloaderImpl implements LowLevelDownloader {
	get(uri: RemoteUriString, options: LowLevelDownloadOptions = {}): Promise<Buffer> {
		const protocol = RemoteUriString.getProtocol(uri)
		const { timeout = 15_000, ...requestOptions } = options
		return new Promise((resolve, reject) => {
			const callback = (res: IncomingMessage) => {
				if (res.statusCode !== 200) {
					res.resume()
					reject(new Error(`Status code ${res.statusCode}: ${res.statusMessage}`))
				} else {
					resolve(promisifyAsyncIterable(res, chunks => Buffer.concat(chunks)))
				}
			}
			const req = protocol === 'http:'
				? http.get(uri, requestOptions, callback)
				: https.get(uri, requestOptions, callback)
			req.on('error', reject)
			// Idle-socket timeout, which also covers a body that stalls midway.
			req.setTimeout(timeout, () => req.destroy(new Error(`Timed out after ${timeout} ms: ${uri}`)))
		})
	}
}

interface LowLevelDownloaderMockOptions {
	/**
	 * A record from URIs to fixture data. The {@link LowLevelDownloader.get} only returns a {@link Buffer},
	 * therefore `string` fixtures will be turned into a `Buffer` and `object` fixtures will be transformed
	 * into JSON and then turned into a `Buffer`.
	 */
	fixtures: Record<RemoteUriString, string | Buffer | object>,
}

class LowLevelDownloaderMock implements LowLevelDownloader {
	constructor(private readonly options: LowLevelDownloaderMockOptions) { }

	async get(uri: RemoteUriString): Promise<Buffer> {
		if (!this.options.fixtures[uri]) {
			throw new Error(`404 not found: ${uri}`)
		}
		const fixture = this.options.fixtures[uri]
		if (Buffer.isBuffer(fixture)) {
			return fixture
		} else if (typeof fixture === 'string') {
			return Buffer.from(fixture, 'utf-8')
		} else {
			return Buffer.from(JSON.stringify(fixture), 'utf-8')
		}
	}
}
