import type { NbtChunk } from 'deepslate'
import { NbtFile, NbtRegion, NbtType, RawDataInput } from 'deepslate'
import * as vscode from 'vscode'
import { applyEdit, reverseEdit } from './common/Operations'
import type { Logger, NbtEdit } from './common/types'
import { Disposable } from './dispose'

// Workaround for deepslate reading the string length as a signed short, so strings over 32767 bytes get a bogus length and overflow the stack while decoding (upstream #87). Drop this once deepslate reads it unsigned.
RawDataInput.prototype.readString = function(this: RawDataInput) {
	const bytes = this.readBytes(this.readShort() & 0xFFFF)
	const units: number[] = []
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i]
		if (b < 0x80) {
			units.push(b)
		} else if ((b & 0xE0) === 0xC0) {
			units.push(((b & 0x1F) << 6) | (bytes[++i] & 0x3F))
		} else if ((b & 0xF0) === 0xE0) {
			units.push(((b & 0x0F) << 12) | ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F))
		} else {
			const c = ((b & 0x07) << 18) | ((bytes[++i] & 0x3F) << 12) | ((bytes[++i] & 0x3F) << 6) | (bytes[++i] & 0x3F)
			units.push(0xD800 + ((c - 0x10000) >> 10), 0xDC00 + ((c - 0x10000) & 0x3FF))
		}
	}
	let result = ''
	for (let i = 0; i < units.length; i += 4096) {
		result += String.fromCharCode(...units.slice(i, i + 4096))
	}
	return result
}

export class NbtDocument extends Disposable implements vscode.CustomDocument {

	static async create(
		uri: vscode.Uri,
		backupId: string | undefined,
		logger: Logger,
	): Promise<NbtDocument | PromiseLike<NbtDocument>> {
		const dataFile = typeof backupId === 'string' ? vscode.Uri.parse(backupId) : uri
		logger.info(`Creating NBT document [uri=${JSON.stringify(dataFile)}]`)
		// parse the backup bytes but detect the format from the original uri
		const fileData = await NbtDocument.readFile(dataFile, logger, uri)
		return new NbtDocument(uri, fileData, logger)
	}

	private static async readFile(uri: vscode.Uri, logger: Logger, formatUri: vscode.Uri = uri): Promise<NbtFile | NbtRegion> {
		const array = await vscode.workspace.fs.readFile(uri)

		logger.info(`Read file [length=${array.length}, scheme=${uri.scheme}, extension=${uri.path.match(/(?:\.([^.]+))?$/)?.[1]}]`)

		if (uri.scheme === 'git' && array.length === 0) {
			return NbtFile.create()
		}

		if (formatUri.fsPath.endsWith('.mca')) {
			return NbtRegion.read(array)
		}

		let littleEndian = formatUri.fsPath.endsWith('.mcstructure')
		let file: NbtFile
		try {
			file = NbtFile.read(array, { littleEndian, bedrockHeader: littleEndian })
			if (file.root.size === 0) {
				// if the file is empty, we try to read using the opposite endianness
				const otherFile = NbtFile.read(array, { littleEndian: !littleEndian, bedrockHeader: !littleEndian })
				if (otherFile.root.size > 0) {
					littleEndian = !littleEndian
					file = otherFile
				}
			}
		} catch (e) {
			// if reading throws, we try to read using opposite endianness
			littleEndian = !littleEndian
			try {
				file = NbtFile.read(array, { littleEndian, bedrockHeader: littleEndian })
			} catch {
				// report the first error, the retry's error is usually misleading
				throw e instanceof Error && e.message === 'Top tag should be a compound'
					? new Error('Top tag should be a compound, other root tag types are not supported')
					: e
			}
		}

		logger.info(`Parsed NBT [compression=${file.compression ?? 'none'}, littleEndian=${file.littleEndian ?? false}, bedrockHeader=${file.bedrockHeader ?? 'none'}]`)

		return file
	}


	private readonly _uri: vscode.Uri

	private _documentData: NbtFile | NbtRegion
	private readonly _isStructure: boolean
	private readonly _isMap: boolean
	private readonly _isReadOnly: boolean

	private constructor(
		uri: vscode.Uri,
		initialContent: NbtFile | NbtRegion,
		private readonly logger: Logger,
	) {
		super()
		this._uri = uri
		this._documentData = initialContent
		this._isStructure = this.isStructureData()
		this._isMap = this.isMapData()

		this._isReadOnly = uri.scheme === 'git'
	}

	public get uri() { return this._uri }

	public get documentData() { return this._documentData }

	public get isStructure() { return this._isStructure }

	public get isMap() { return this._isMap }

	public get isReadOnly() { return this._isReadOnly }

	public get dataVersion(): number | undefined {
		const file = this._documentData
		if (file instanceof NbtRegion) {
			const firstChunk = file.getFirstChunk()
			return firstChunk?.getRoot().getNumber('DataVersion') ?? 0
		} else if (file.root.has('Blocks') && file.root.has('Data')) {
			// schematic files don't have DataVersion
			// should be 1.12 but mcmeta doesn't have that, so using 1.14
			// TODO: handle {Materials:"Pocket"} differently
			return 1952
		} else if (file.root.hasCompound('structure')) {
			// bedrock mcstructure files don't have DataVersion, use the latest release instead
			return undefined
		} else {
			// for .litematic files
			if (this.uri.fsPath.endsWith('.litematic')) {
				return file.root.getNumber('MinecraftDataVersion')
			}
			return file.root.getNumber('DataVersion') ?? 0
		}
	}

	private readonly _onDidDispose = this._register(new vscode.EventEmitter<void>())
	public readonly onDidDispose = this._onDidDispose.event

	private readonly _onDidChangeDocument = this._register(new vscode.EventEmitter<NbtEdit>())
	public readonly onDidChangeContent = this._onDidChangeDocument.event

	private _epoch = 0

	// fired when the webviews must reload the full state
	private readonly _onDidReset = this._register(new vscode.EventEmitter<void>())
	public readonly onDidReset = this._onDidReset.event

	private readonly _onDidChange = this._register(new vscode.EventEmitter<{
		readonly label: string,
		undo(): void,
		redo(): void,  
	}>())
	public readonly onDidChange = this._onDidChange.event

	dispose(): void {
		this._onDidDispose.fire()
		super.dispose()
	}

	makeEdit(edit: NbtEdit) {
		if (this._isReadOnly) {
			vscode.window.showWarningMessage('Cannot edit in read-only editor')
			return
		}

		applyEdit(this._documentData, edit, this.logger)
		const reversed = reverseEdit(edit)
		const epoch = this._epoch
		const run = (e: NbtEdit) => {
			if (epoch !== this._epoch) {
				return // stale entry from before a revert
			}
			try {
				applyEdit(this._documentData, e, this.logger)
			} catch (err) {
				this._onDidReset.fire()
				throw err
			}
			this._onDidChangeDocument.fire(e)
		}

		this._onDidChange.fire({
			label: 'Edit',
			undo: async () => run(reversed),
			redo: async () => run(edit),
		})
		this._onDidChangeDocument.fire(edit)
	}

	private isStructureData() {
		if (this._documentData instanceof NbtRegion) {
			return false // region file
		}
		if (this.uri.fsPath.endsWith('.schem') || this.uri.fsPath.endsWith('.schematic') || this.uri.fsPath.endsWith('.litematic')) {
			return true // schematic
		}
		const root = this._documentData.root
		if (root.hasList('size', NbtType.Int, 3) && root.hasList('blocks') && root.hasList('palette')) {
			return true // vanilla structure
		}
		if (root.hasList('size', NbtType.Int, 3) && root.hasCompound('structure')) {
			return true // bedrock mcstructure
		}
		return false // anything else
	}

	private isMapData() {
		return this._uri.fsPath.match(/(?:\\|\/)map_\d+\.dat$/) !== null
	}

	async getChunkData(x: number, z: number): Promise<NbtChunk> {
		if (!(this._documentData instanceof NbtRegion)) {
			throw new Error('File is not a region file')
		}

		const chunk = this._documentData.findChunk(x, z)
		if (!chunk) {
			throw new Error(`Cannot find chunk [${x}, ${z}]`)
		}
		return chunk
	}

	async save(cancellation: vscode.CancellationToken): Promise<void> {
		if (this._isReadOnly) {
			return
		}
		await this.saveAs(this.uri, cancellation)
	}

	async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
		if (cancellation.isCancellationRequested) {
			throw new vscode.CancellationError()
		}

		const fileData = this._documentData.write()
		if (cancellation.isCancellationRequested) {
			throw new vscode.CancellationError()
		}

		await vscode.workspace.fs.writeFile(targetResource, fileData)
	}

	async revert(_cancellation: vscode.CancellationToken): Promise<void> {
		this._documentData = await NbtDocument.readFile(this.uri, this.logger)
		this._epoch++
		this._onDidReset.fire()
	}

	async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
		await this.saveAs(destination, cancellation)
		return {
			id: destination.toString(),
			delete: async () => {
				try {
					await vscode.workspace.fs.delete(destination)
				} catch { }
			},
		}
	}
}
