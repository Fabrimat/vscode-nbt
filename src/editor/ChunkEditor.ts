import type { BlockPos, NbtCompound, NbtFile, NbtTag } from 'deepslate'
import { BlockState, NbtType, Structure } from 'deepslate'
import { vec3 } from 'gl-matrix'
import { shouldSkipAir } from './Schematics'
import { StructureEditor } from './StructureEditor'

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const VERSION_20w17a = 2529
const VERSION_21w43a = 2844

// Palette entries are compounds, or strings like "minecraft:oak_log[axis=y]" since DataVersion ~5023
const paletteState = (tag: NbtTag) => tag.isString() ? BlockState.parse(tag.getAsString()) : BlockState.fromNbt(tag as NbtCompound)
const paletteName = (tag: NbtTag) => tag.isString() ? tag.getAsString().split('[')[0] : (tag as NbtCompound).getString('Name')

export class ChunkEditor extends StructureEditor {

	onInit(file: NbtFile) {
		this.updateStructure(file)
		vec3.copy(this.cPos, this.structure.getSize())
		vec3.mul(this.cPos, this.cPos, [-0.5, -1, -0.5])
		vec3.add(this.cPos, this.cPos, [0, 16, 0])
		this.cDist = 25
		this.showSidePanel()
		this.render()
	}

	protected loadStructure() {
		this.gridActive = false

		const dataVersion = this.file.root.getNumber('DataVersion')
		const N = dataVersion >= VERSION_21w43a
		const stretches = dataVersion < VERSION_20w17a

		const sections = N
			? this.file.root.getList('sections', NbtType.Compound)
			: this.file.root.getCompound('Level').getList('Sections', NbtType.Compound)

		const filledSections = sections.filter(section => {
			const palette = N
				? section.getCompound('block_states').getList('palette')
				: section.has('Palette') && section.getList('Palette')
			return palette &&
				palette.filter(state => paletteName(state) !== 'minecraft:air')
					.length > 0
		})
		if (filledSections.length === 0) {
			throw new Error('Empty chunk')
		}
		const minY = 16 * Math.min(...filledSections.map(s => s.getNumber('Y')))
		const maxY = 16 * Math.max(...filledSections.map(s => s.getNumber('Y')))

		const K_palette = N ? 'palette' : 'Palette'
		const K_data = N ? 'data' : 'BlockStates'

		const skipAir = shouldSkipAir(16, maxY - minY + 16, 16)
		const allPalette: BlockState[] = []
		const allBlocks: { pos: BlockPos, state: number }[] = []
		for (const section of filledSections) {
			const states = N ? section.getCompound('block_states') : section
			if (!states.has(K_palette)) {
				continue
			}
			const yOffset = section.getNumber('Y') * 16 - minY
			const palette = states.getList(K_palette).getItems().map(paletteState)
			const paletteOffset = allPalette.length
			const air = palette.map(s => AIR.has(s.getName().toString()))
			if (!states.has(K_data)) {
				// A single-entry palette without data fills the whole section
				if (N && palette.length === 1 && !(skipAir && air[0])) {
					for (let j = 0; j < 4096; j += 1) {
						allBlocks.push({ pos: [j & 0xF, yOffset + (j >> 8), (j >> 4) & 0xF], state: paletteOffset })
					}
				}
			} else {
				const blockStates = states.getLongArray(K_data)
				const tempDataview = new DataView(new Uint8Array(8).buffer)
				const statesData = blockStates.map(long => {
					tempDataview.setInt32(0, Number(long.getAsPair()[0]))
					tempDataview.setInt32(4, Number(long.getAsPair()[1]))
					return tempDataview.getBigUint64(0)
				})

				const bits = Math.max(4, Math.ceil(Math.log2(palette.length)))
				const bigBits = BigInt(bits)
				const big0 = BigInt(0)
				const big64 = BigInt(64)
				const bitMask = BigInt(Math.pow(2, bits) - 1)
				let state = 0
				let data = statesData[state] ?? big0
				let dataLength = big64

				for (let j = 0; j < 4096; j += 1) {
					if (dataLength < bits) {
						state += 1
						const newData = statesData[state] ?? big0
						if (stretches) {
							data = (newData << dataLength) | data
							dataLength += big64
						} else {
							data = newData
							dataLength = big64
						}
					}
					const paletteId = Number(data & bitMask)
					if (palette[paletteId] && !(skipAir && air[paletteId])) {
						allBlocks.push({ pos: [j & 0xF, yOffset + (j >> 8), (j >> 4) & 0xF], state: paletteOffset + paletteId })
					}
					data >>= bigBits
					dataLength -= bigBits
				}
			}
			for (const p of palette) allPalette.push(p)
		}
		return new Structure([16, maxY - minY + 16, 16], allPalette, allBlocks)
	}

	menu() {
		return []
	}

	protected showSidePanel() {
		this.root.querySelector('.side-panel')?.remove()
		const block = this.selectedBlock ? this.structure.getBlock(this.selectedBlock) : null
		if (block) {
			super.showSidePanel()
		}
	}
}
