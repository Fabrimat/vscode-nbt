import type { BlockPos } from 'deepslate'
import { BlockState, NbtCompound, NbtType, Structure } from 'deepslate'
import { fromAlphaMaterial } from './AlphaMaterials'
import { OPAQUE_BLOCKS } from './BlockFlags'
import type { StructureRegion } from './MultiStructure'
import { MultiStructure } from './MultiStructure'

function getTriple(tag: NbtCompound): BlockPos {
	return [tag.getNumber('x'), tag.getNumber('y'), tag.getNumber('z')]
}

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
// Air is only dropped for large structures, where invisible blocks are unavailable anyway
export const shouldSkipAir = (width: number, height: number, length: number) => width * height * length > 48 * 48 * 48
const isAir = (state: BlockState) => AIR.has(state.getName().toString())
const isAirArray = (palette: BlockState[]) => palette.map(isAir)

type RawBlock = { pos: BlockPos, state: number, nbt?: NbtCompound }

// Sponge v3 nests everything under `Schematic`, with the block data under `Blocks`
function spongeBlocksTag(root: NbtCompound) {
	return root.hasCompound('Schematic') ? root.getCompound('Schematic') : root
}

export function isSponge(root: NbtCompound) {
	const schem = spongeBlocksTag(root)
	if (schem.hasCompound('Blocks')) {
		return schem.getCompound('Blocks').get('Data')?.isByteArray() === true
	}
	return schem.get('BlockData')?.isByteArray() === true && schem.hasCompound('Palette')
}

export function spongeToStructure(root: NbtCompound) {
	const schem = spongeBlocksTag(root)
	const width = schem.getNumber('Width')
	const height = schem.getNumber('Height')
	const length = schem.getNumber('Length')
	const v3 = schem.hasCompound('Blocks')
	const blocksTag = v3 ? schem.getCompound('Blocks') : schem

	const schemPalette = blocksTag.getCompound('Palette')
	const palette: BlockState[] = []
	for (const key of schemPalette.keys()) {
		palette[schemPalette.getNumber(key)] = BlockState.parse(key)
	}
	const air = isAirArray(palette)
	const skipAir = shouldSkipAir(width, height, length)

	const blockData = blocksTag.getByteArray(v3 ? 'Data' : 'BlockData').map(e => e.getAsNumber())
	const blockEntities = new Map<number, NbtCompound>()
	const beKey = v3 || blocksTag.has('BlockEntities') ? 'BlockEntities' : 'TileEntities'
	blocksTag.getList(beKey, NbtType.Compound).forEach((tag) => {
		const [x, y, z] = tag.getIntArray('Pos').map(e => e.getAsNumber())
		const copy = NbtCompound.fromJson(tag.toJson())
		copy.delete('Pos')
		blockEntities.set(x + z * width + y * width * length, copy)
	})
	const blocks: RawBlock[] = []
	let i = 0
	const total = blockData.length
	for (let y = 0; y < height; y += 1) {
		for (let z = 0; z < length; z += 1) {
			for (let x = 0; x < width; x += 1) {
				// varint, bytes are signed in NBT so mask them
				let id = 0
				let shift = 0
				while (i < total) {
					const b = blockData[i] & 0xFF
					i += 1
					id |= (b & 0x7F) << shift
					shift += 7
					if ((b & 0x80) === 0) break
				}
				if (skipAir && air[id]) continue
				blocks.push({
					pos: [x, y, z],
					state: id,
					nbt: blockEntities.get(x + z * width + y * width * length),
				})
			}
		}
	}

	return new Structure([width, height, length], palette, blocks)
}

export function litematicToStructure(root: NbtCompound) {
	const enclosingSize = root.getCompound('Metadata').getCompound('EnclosingSize')
	const [width, height, length] = getTriple(enclosingSize)

	const regions: StructureRegion[] = []
	const regionsTag = root.getCompound('Regions')
	// Air in overlapping regions would hide blocks of the regions below it
	const skipAir = [...regionsTag.keys()].length > 1 || shouldSkipAir(width, height, length)
	regionsTag.forEach((name, region) => {
		if (!region.isCompound()) return
		const pos = getTriple(region.getCompound('Position'))
		const size = getTriple(region.getCompound('Size'))
		for (let i = 0; i < 3; i += 1) {
			if (size[i] < 0) {
				pos[i] += size[i] + 1
				size[i] = -size[i]
			}
		}
		const volume = size[0] * size[1] * size[2]
		const stretches = true

		const palette = region.getList('BlockStatePalette', NbtType.Compound).map(BlockState.fromNbt)
		const blockStates = region.getLongArray('BlockStates')
		const tempDataview = new DataView(new Uint8Array(8).buffer)
		const statesData = blockStates.map(long => {
			tempDataview.setInt32(0, Number(long.getAsPair()[0]))
			tempDataview.setInt32(4, Number(long.getAsPair()[1]))
			return tempDataview.getBigUint64(0)
		})

		// litematica use at least 2 bits for palette indices (https://github.com/misode/vscode-nbt/issues/76)
		const bits = Math.max(2, Math.ceil(Math.log2(palette.length)))
		const bigBits = BigInt(bits)
		const big0 = BigInt(0)
		const big64 = BigInt(64)
		const bitMask = BigInt(Math.pow(2, bits) - 1)
		let state = 0
		let data = statesData[state] ?? big0
		let dataLength = big64

		const arr: number[] = []
		for (let j = 0; j < volume; j += 1) {
			if (dataLength < bits) {
				state += 1
				let newData = statesData[state]
				if (newData === undefined) {
					console.error(`Out of bounds states access ${state}`)
					newData = big0
				}
				if (stretches) {
					data = (newData << dataLength) | data
					dataLength += big64
				} else {
					data = newData
					dataLength = big64
				}
			}

			let paletteId = Number(data & bitMask)
			if (paletteId > palette.length - 1) {
				console.error(`Invalid palette ID ${paletteId}`)
				paletteId = 0
			}
			arr.push(paletteId)
			data >>= bigBits
			dataLength -= bigBits
		}
		const air = skipAir ? isAirArray(palette) : []
		const blocks: RawBlock[] = []
		const blockEntities = new Map<string, NbtCompound>()
		region.getList('TileEntities', NbtType.Compound).forEach((tag) => {
			const pos = getTriple(tag).toString()
			const copy = NbtCompound.fromJson(tag.toJson())
			copy.delete('x')
			copy.delete('y')
			copy.delete('z')
			blockEntities.set(pos, copy)
		})
		const hasEntities = blockEntities.size > 0
		for (let x = 0; x < size[0]; x += 1) {
			for (let y = 0; y < size[1]; y += 1) {
				for (let z = 0; z < size[2]; z += 1) {
					const index = (y * size[0] * size[2]) + z * size[0] + x
					const id = arr[index]
					if (air[id]) continue
					blocks.push({
						pos: [x, y, z],
						state: id,
						nbt: hasEntities ? blockEntities.get([x, y, z].toString()) : undefined,
					})
				}
			}
		}
		const structure = new Structure(size, palette, blocks)
		regions.push({ pos, structure, name })
	})

	const minPos: BlockPos = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
	for (const region of regions) {
		for (let i = 0; i < 3; i += 1) {
			minPos[i] = Math.min(minPos[i], region.pos[i])
		}
	}
	for (const region of regions) {
		for (let i = 0; i < 3; i += 1) {
			region.pos[i] -= minPos[i]
		}
	}

	return new MultiStructure([width, height, length], regions)
}

export function mcstructureToStructure(root: NbtCompound) {
	const [width, height, length] = root.getList('size', NbtType.Int).map(e => e.getAsNumber())

	const structureCompound = root.getCompound('structure')
	const paletteCompound = structureCompound.getCompound('palette')
	const defaultKey = paletteCompound.hasCompound('default') ? 'default' : [...paletteCompound.keys()][0]
	const defaultPalette = paletteCompound.getCompound(defaultKey)

	const palette: BlockState[] = defaultPalette.getList('block_palette', NbtType.Compound).map(entry => {
		const name = entry.getString('name')
		const properties: Record<string, string> = {}
		entry.getCompound('states').forEach((key, tag) => {
			if (tag.isByte()) {
				properties[key] = tag.getAsNumber() === 0 ? 'false' : 'true'
			} else if (tag.isString()) {
				properties[key] = tag.getAsString()
			} else {
				properties[key] = String(tag.getAsNumber())
			}
		})
		return new BlockState(name, properties)
	})

	const blockPositionData = defaultPalette.getCompound('block_position_data')

	const layers = structureCompound.getList('block_indices', NbtType.List)
	const indices = layers.getList(0, NbtType.Int).map(e => e.getAsNumber())
	// Layer 1 holds liquids, waterlogged blocks are stored as water in this layer
	const liquid = layers.length > 1 ? layers.getList(1, NbtType.Int).map(e => e.getAsNumber()) : []
	const air = isAirArray(palette)
	const skipAir = shouldSkipAir(width, height, length)
	const waterlogged = new Map<number, number>()

	const blocks: RawBlock[] = []
	for (let x = 0; x < width; x += 1) {
		for (let y = 0; y < height; y += 1) {
			for (let z = 0; z < length; z += 1) {
				const i = (x * height + y) * length + z
				let state = indices[i]
				if (state === undefined || state < 0 || state > palette.length - 1) {
					if (state !== undefined && state >= 0) console.error(`Invalid palette ID ${state}`)
					state = -1
				}
				const liquidState = liquid[i]
				if (liquidState !== undefined && liquidState >= 0 && liquidState < palette.length
					&& palette[liquidState].getName().toString() === 'minecraft:water') {
					if (state === -1 || air[state]) {
						state = liquidState
					} else if (!OPAQUE_BLOCKS.has(palette[state].getName().toString())) {
						let wl = waterlogged.get(state)
						if (wl === undefined) {
							wl = palette.length
							palette.push(new BlockState(palette[state].getName(), { ...palette[state].getProperties(), waterlogged: 'true' }))
							waterlogged.set(state, wl)
						}
						state = wl
					}
				}
				if (state === -1 || (skipAir && air[state])) continue
				const blockData = blockPositionData.hasCompound(String(i)) ? blockPositionData.getCompound(String(i)) : undefined
				const blockEntityTag = blockData?.hasCompound('block_entity_data') ? blockData.getCompound('block_entity_data') : undefined
				const nbt = blockEntityTag ? NbtCompound.fromJson(blockEntityTag.toJson()) : undefined
				blocks.push({ pos: [x, y, z], state, nbt })
			}
		}
	}

	return new Structure([width, height, length], palette, blocks)
}

export function schematicToStructure(root: NbtCompound) {
	const width = root.getNumber('Width')
	const height = root.getNumber('Height')
	const length = root.getNumber('Length')

	const blocksArray = root.getByteArray('Blocks').map(e => e.getAsNumber())
	const dataArray = root.getByteArray('Data').map(e => e.getAsNumber())
	// AddBlocks stores the high 4 bits of the id, two blocks per byte (even index in the low nibble)
	const addArray = root.has('AddBlocks') ? root.getByteArray('AddBlocks').map(e => e.getAsNumber()) : []

	const blockEntities = new Map<string, NbtCompound>()
	root.getList('TileEntities', NbtType.Compound).forEach((tag) => {
		const pos = getTriple(tag).toString()
		const copy = NbtCompound.fromJson(tag.toJson())
		copy.delete('x')
		copy.delete('y')
		copy.delete('z')
		blockEntities.set(pos, copy)
	})
	const hasEntities = blockEntities.size > 0

	const skipAir = shouldSkipAir(width, height, length)
	const palette: BlockState[] = []
	const paletteIds = new Map<number, number>() // id << 4 | data -> palette index, -1 for air
	const blocks: RawBlock[] = []
	for (let x = 0; x < width; x += 1) {
		for (let y = 0; y < height; y += 1) {
			for (let z = 0; z < length; z += 1) {
				const i = (y * width * length) + z * width + x
				let id = (blocksArray[i] ?? 0) & 0xFF
				const add = addArray[i >> 1]
				if (add !== undefined) {
					id |= (((i & 1) === 0 ? add : add >> 4) & 0xF) << 8
				}
				const key = id << 4 | ((dataArray[i] ?? 0) & 0xF)
				let state = paletteIds.get(key)
				if (state === undefined) {
					const blockState = fromAlphaMaterial(id, key & 0xF)
					if (skipAir && isAir(blockState)) {
						state = -1
					} else {
						state = palette.length
						palette.push(blockState)
					}
					paletteIds.set(key, state)
				}
				if (state === -1) continue
				blocks.push({ pos: [x, y, z], state, nbt: hasEntities ? blockEntities.get([x, y, z].toString()) : undefined })
			}
		}
	}

	return new Structure([width, height, length], palette, blocks)
}
