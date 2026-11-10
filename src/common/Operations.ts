import type { NbtCompound, NbtFile } from 'deepslate'
import { NbtByte, NbtChunk, NbtDouble, NbtFloat, NbtInt, NbtLong, NbtRegion, NbtShort, NbtString, NbtTag, NbtType } from 'deepslate'
import { NbtPath } from './NbtPath'
import type { Logger, NbtEdit } from './types'

export function reverseEdit(edit: NbtEdit): NbtEdit {
	switch(edit.type) {
		case 'composite': return { ...edit, edits: [...edit.edits].reverse().map(reverseEdit) }
		case 'chunk': return { ...edit, edit: reverseEdit(edit.edit) }
		case 'set': return { ...edit, new: edit.old, old: edit.new }
		case 'add': return { ...edit, type: 'remove' }
		case 'remove': return { ...edit, type: 'add' }
		case 'move': return { ...edit, path: edit.source, source: edit.path }
	}
}

export function mapEdit(edit: NbtEdit, mapper: (e: NbtEdit & { type: 'set' | 'add' | 'remove' | 'move' }) => NbtEdit): NbtEdit {
	switch(edit.type) {
		case 'composite': return { ...edit, edits: edit.edits.map(e => mapEdit(e, mapper)) }
		case 'chunk': return { ...edit, edit: mapEdit(edit.edit, mapper) }
		default: return mapper(edit)
	}
}

export function applyEdit(file: NbtFile | NbtRegion | NbtRegion.Ref, edit: NbtEdit, logger?: Logger) {
	logger?.info(`Applying edit to file ${editToString(edit)}`)
	if (file instanceof NbtRegion || file instanceof NbtRegion.Ref) {
		if (edit.type !== 'chunk') {
			throw new Error(`Expected chunk edit, but got '${edit.type}'`)
		}
		const chunk = file.findChunk(edit.x, edit.z)
		const chunkFile = chunk?.getFile()
		if (chunkFile === undefined) {
			// chunk does not exist or the ref is not loaded, so no need to apply any edits.
			logger?.error(`Cannot apply chunk edit, chunk x=${edit.x} z=${edit.z} is not loaded or does not exist`)
			return
		}
		applyEdit(chunkFile, edit.edit, logger)
		if (chunk instanceof NbtChunk) {
			chunk.markDirty()
		}
	} else {
		if (edit.type === 'chunk') {
			throw new Error('Cannot apply chunk edit, this is not a region file')
		}
		if (edit.type !== 'composite' && edit.path.length === 0) {
			if (edit.type !== 'set') {
				throw new Error(`Cannot apply ${edit.type} edit on the root, expected 'set'`)
			}
			const newTag = NbtTag.fromJsonWithId(edit.new)
			if (!newTag.isCompound()) {
				throw new Error(`Expected a compound, but got ${NbtType[newTag.getId()]}`)
			}
			file.root = newTag
		} else {
			applyEditTag(file.root, edit, logger)
		}
	}
}

export function getEditedFile(file: NbtFile | NbtRegion | NbtRegion.Ref, edit: NbtEdit) {
	if (file instanceof NbtRegion || file instanceof NbtRegion.Ref) {
		if (edit.type !== 'chunk') {
			throw new Error(`Expected chunk edit, but got '${edit.type}'`)
		}
		const chunk = file.findChunk(edit.x, edit.z)
		return { file: chunk?.getFile(), edit: edit.edit }
	} else {
		return { file, edit }
	}
}

export function applyEditTag(tag: NbtTag, edit: NbtEdit, logger?: Logger) {
	logger?.info(`Applying edit ${editToString(edit)}`)
	try {
		if (edit.type === 'composite') {
			// Atomic: if a sub-edit fails, undo the ones already applied.
			const applied: NbtEdit[] = []
			try {
				for (const sub of edit.edits) {
					applyEditTag(tag, sub, logger)
					applied.push(sub)
				}
			} catch (e) {
				for (const done of applied.reverse()) {
					try {
						applyEditTag(tag, reverseEdit(done), logger)
					} catch (re) {
						logger?.error(`Error rolling back edit: ${re.message}`)
					}
				}
				throw e
			}
			return
		} else if (edit.type === 'chunk') {
			throw new Error('Cannot apply chunk edit to a tag')
		}
		if (edit.path.length === 0) {
			throw new Error('Cannot apply edit to the root')
		}
		const path = new NbtPath(edit.path)
		const node = getNode(tag, path.pop())
		const last = path.last()
		switch(edit.type) {
			case 'set': return setValue(node, last, NbtTag.fromJsonWithId(edit.new))
			case 'add': return addValue(node, last, NbtTag.fromJsonWithId(edit.value))
			case 'remove': return removeValue(node, last)
			case 'move': {
				if (edit.source.length === 0) {
					throw new Error('Cannot move the root')
				}
				const sPath = new NbtPath(edit.source)
				const sNode = getNode(tag, sPath.pop())
				const sLast = sPath.last()
				return moveNode(node, last, sNode, sLast)
			}
		}
	} catch (e) {
		logger?.error(`Error applying edit to tag: ${e.message}`)
		throw e
	}
}

function editToString(edit: NbtEdit) {
	return `type=${edit.type} ${edit.type === 'chunk' ? `x=${edit.x} z=${edit.z} ` : ''}${edit.type !== 'composite' && edit.type !== 'chunk' ? ` path=${new NbtPath(edit.path).toString()}` : ''} ${edit.type === 'remove' || edit.type === 'composite' || edit.type === 'chunk' ? '' : edit.type === 'move' ? `source=${new NbtPath(edit.source).toString()}` : `value=${(a => a.slice(0, 40) + (a.length > 40 ? '...' : ''))(JSON.stringify(edit.type === 'set' ? edit.new : edit.value))}`}`
}

export function getNode(tag: NbtTag, path: NbtPath) {
	let node: NbtTag | undefined = tag
	for (const el of path.arr) {
		if (node?.isCompound() && typeof el === 'string') {
			node = node.get(el)
		} else if (node?.isListOrArray() && typeof el === 'number') {
			node = node.get(el)
		} else {
			node = undefined
		}
		if (node === undefined) {
			throw new Error(`Invalid path ${path.toString()}`)
		}
	}
	return node
}

function moveNode(tag: NbtTag, last: number | string, sTag: NbtTag, sLast: number | string) {
	if (tag === sTag && last === sLast) {
		return
	}
	if (tag.isCompound() && typeof last === 'string' && tag.has(last)) {
		throw new Error(`Cannot move, '${last}' already exists`)
	}
	const value = getNode(sTag, new NbtPath([sLast]))
	addValue(tag, last, value)
	removeValue(sTag, sLast)
}

function mismatch(tag: NbtTag, last: number | string): never {
	throw new Error(`Cannot access '${last}' on ${NbtType[tag.getId()]}`)
}

function setValue(tag: NbtTag, last: number | string, value: NbtTag) {
	if (tag.isCompound() && typeof last === 'string') {
		tag.set(last, value)
	} else if (tag.isList() && typeof last === 'number' && last >= 0 && last < tag.length) {
		tag.set(last, value)
	} else if (tag.isByteArray() && typeof last === 'number' && last >= 0 && last < tag.length && value.isByte()) {
		tag.set(last, value)
	} else if (tag.isIntArray() && typeof last === 'number' && last >= 0 && last < tag.length && value.isInt()) {
		tag.set(last, value)
	} else if (tag.isLongArray() && typeof last === 'number' && last >= 0 && last < tag.length && value.isLong()) {
		tag.set(last, value)
	} else {
		mismatch(tag, last)
	}
}

function addValue(tag: NbtTag, last: number | string, value: NbtTag) {
	if (tag.isCompound() && typeof last === 'string') {
		if (tag.has(last)) {
			throw new Error(`Cannot add, '${last}' already exists`)
		}
		tag.set(last, value)
	} else if (tag.isList() && typeof last === 'number' && last >= 0 && last <= tag.length) {
		tag.insert(last, value)
	} else if (tag.isByteArray() && typeof last === 'number' && last >= 0 && last <= tag.length && value.isByte()) {
		tag.insert(last, value)
	} else if (tag.isIntArray() && typeof last === 'number' && last >= 0 && last <= tag.length && value.isInt()) {
		tag.insert(last, value)
	} else if (tag.isLongArray() && typeof last === 'number' && last >= 0 && last <= tag.length && value.isLong()) {
		tag.insert(last, value)
	} else {
		mismatch(tag, last)
	}
}

function removeValue(tag: NbtTag, last: number | string) {
	if (tag.isCompound() && typeof last === 'string' && tag.has(last)) {
		tag.delete(last)
	} else if (tag.isListOrArray() && typeof last === 'number' && last >= 0 && last < tag.length) {
		tag.delete(last)
	} else {
		mismatch(tag, last)
	}
}

export type SearchQuery = {
	type?: number,
	name?: string,
	value?: string,
}

export function searchNodes(tag: NbtCompound, query: SearchQuery): NbtPath[] {
	const results: NbtPath[] = []
	let parsedValue: NbtTag | undefined = undefined
	try {
		if (query.value !== undefined) {
			parsedValue = NbtTag.fromString(query.value)
		}
	} catch (e) {}
	searchNodesImpl(new NbtPath(), tag, query, results, parsedValue)
	return results
}

function searchNodesImpl(path: NbtPath, tag: NbtTag, query: SearchQuery, results: NbtPath[], parsedValue: NbtTag | undefined) {
	if (matchesNode(path, tag, query, parsedValue)) {
		results.push(path)
	}
	if (tag.isCompound()) {
		[...tag.keys()].sort().forEach(k => {
			searchNodesImpl(path.push(k), tag.get(k)!, query, results, parsedValue)
		})
	} else if (tag.isListOrArray()) {
		tag.forEach((v, i) => {
			searchNodesImpl(path.push(i), v, query, results, parsedValue)
		})
	}
}

function matchesNode(path: NbtPath, tag: NbtTag, query: SearchQuery, parsedValue: NbtTag | undefined): boolean {
	const last = path.last()
	const typeMatches = !query.type || tag.getId() === query.type
	const nameMatches = !query.name || (typeof last === 'string' && last.includes(query.name))
	const valueMatches = !query.value || matchesValue(tag, query.value, parsedValue)
	return typeMatches && nameMatches && valueMatches
}

function matchesValue(tag: NbtTag, value: string, parsedValue: NbtTag | undefined): boolean {
	if (parsedValue && tag.getId() == parsedValue.getId() && tag.toString() == parsedValue.toString()) {
		return true
	}
	try {
		if (tag.isString()) {
			return tag.getAsString().includes(value)
		} else if (tag.isLong()) {
			const long = NbtLong.bigintToPair(BigInt(value))
			return tag.getAsPair()[0] === long[0] && tag.getAsPair()[1] === long[1]
		} else if (tag.isNumber()) {
			return tag.getAsNumber() === JSON.parse(value)
		}
	} catch (e) {}
	return false
}

/**
 * Builds the edit for replacing a search result, or null if nothing applies to this node.
 * Throws if the new value cannot be parsed or the new name is already taken.
 * `claimed` collects the new paths of previous renames (for replace-all), so they cannot collide.
 */
export function replaceNode(tag: NbtTag, path: NbtPath, replace: SearchQuery, claimed?: Set<string>): NbtEdit | null {
	const edits: NbtEdit[] = []
	const node = getNode(tag, path)
	if (replace.value && !node.isCompound() && !node.isListOrArray()) {
		const newNode = parsePrimitive(node.getId(), replace.value)
		edits.push({ type: 'set', path: path.arr, old: node.toJsonWithId(), new: newNode.toJsonWithId() })
	}
	if (replace.name && typeof path.last() === 'string' && replace.name !== path.last()) {
		const target = path.pop().push(replace.name)
		const key = JSON.stringify(target.arr)
		const parent = getNode(tag, path.pop())
		if (claimed?.has(key) || (parent.isCompound() && parent.has(replace.name))) {
			throw new Error(`Cannot rename to '${replace.name}', it already exists`)
		}
		claimed?.add(key)
		edits.push({ type: 'move', source: path.arr, path: target.arr })
	}
	if (edits.length === 0) {
		return null
	}
	if (edits.length === 1) {
		return edits[0]
	}
	return { type: 'composite', edits }
}

export function serializePrimitive(tag: NbtTag) {
	if (tag.isString()) return tag.getAsString()
	if (tag.isLong()) return NbtLong.pairToString(tag.getAsPair())
	if (tag.isNumber()) return tag.getAsNumber().toString()
	return ''
}

function parseInteger(name: string, value: string, min: number, max: number) {
	const trimmed = value.trim()
	if (!/^[+-]?\d+$/.test(trimmed)) {
		throw new Error(`Invalid ${name} value '${value}'`)
	}
	const parsed = Number(trimmed)
	if (parsed < min || parsed > max) {
		throw new Error(`${name} value '${value}' is out of range (${min} to ${max})`)
	}
	return parsed
}

function parseLong(value: string) {
	const trimmed = value.trim().replace(/[lL]$/, '')
	if (!/^[+-]?\d+$/.test(trimmed)) {
		throw new Error(`Invalid Long value '${value}'`)
	}
	const parsed = BigInt(trimmed)
	if (BigInt.asIntN(64, parsed) !== parsed) {
		throw new Error(`Long value '${value}' is out of range`)
	}
	return parsed
}

export function parsePrimitive(id: number, value: string) {
	switch (id) {
		case NbtType.String: return new NbtString(value)
		case NbtType.Byte: return new NbtByte(parseInteger('Byte', value, -128, 127))
		case NbtType.Short: return new NbtShort(parseInteger('Short', value, -32768, 32767))
		case NbtType.Int: return new NbtInt(parseInteger('Int', value, -2147483648, 2147483647))
		case NbtType.Long: return new NbtLong(parseLong(value))
		case NbtType.Float: return new NbtFloat(parseFloatValue('Float', value))
		case NbtType.Double: return new NbtDouble(parseFloatValue('Double', value))
		default: throw new Error(`Cannot parse a value of type ${NbtType[id] ?? id}`)
	}
}

function parseFloatValue(name: string, value: string) {
	const trimmed = value.trim()
	if (trimmed === 'NaN') return Number.NaN
	if (trimmed === 'Infinity' || trimmed === '+Infinity') return Number.POSITIVE_INFINITY
	if (trimmed === '-Infinity') return Number.NEGATIVE_INFINITY
	if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?$/.test(trimmed)) {
		throw new Error(`Invalid ${name} value '${value}'`)
	}
	const parsed = parseFloat(trimmed)
	if (!Number.isFinite(parsed)) {
		throw new Error(`${name} value '${value}' is out of range`)
	}
	return parsed
}
