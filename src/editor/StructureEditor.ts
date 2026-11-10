import type { StructureProvider } from 'deepslate'
import { BlockPos, BlockState, NbtFile, NbtInt, NbtType, Structure, StructureRenderer } from 'deepslate'
import { mat4, vec2, vec3 } from 'gl-matrix'
import { mapEdit } from '../common/Operations'
import type { NbtEdit } from '../common/types'
import type { EditHandler, EditorPanel, VSCode } from './Editor'
import { locale } from './Locale'
import { ResourceManager } from './ResourceManager'
import { isSponge, litematicToStructure, mcstructureToStructure, schematicToStructure, spongeToStructure } from './Schematics'
import { TreeEditor } from './TreeEditor'
import { clamp, clampVec3, negVec3 } from './Util'

declare const stringifiedAssets: string
declare const stringifiedBlocks: string
declare const stringifiedUvmapping: string

export class StructureEditor implements EditorPanel {
	private readonly resources: ResourceManager
	protected file: NbtFile
	protected structure: StructureProvider
	private readonly warning: HTMLDivElement
	private readonly canvas: HTMLCanvasElement
	private readonly canvas2: HTMLCanvasElement
	private readonly gl2: WebGLRenderingContext
	protected readonly renderer: StructureRenderer
	protected readonly renderer2: StructureRenderer

	private renderRequested = false

	private movement = [0, 0, 0, 0, 0, 0]
	private readonly movementKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft']

	protected readonly cPos: vec3
	protected cRot: vec2
	protected cDist: number

	protected gridActive: boolean
	protected invisibleBlocksActive: boolean
	protected selectedBlock: BlockPos | null

	constructor(protected readonly root: Element, protected readonly vscode: VSCode, protected readonly editHandler: EditHandler, protected readonly readOnly: boolean) {
		const assets = JSON.parse(stringifiedAssets)
		const uvMapping = JSON.parse(stringifiedUvmapping)
		const blocks = JSON.parse(stringifiedBlocks)
		const img = (document.querySelector('.texture-atlas') as HTMLImageElement)
		this.resources = new ResourceManager(blocks, { ...assets, textures: uvMapping }, img)

		this.canvas = document.createElement('canvas')
		this.canvas.className = 'structure-3d'
		const gl = this.canvas.getContext('webgl')!
		this.structure = new Structure([0, 0, 0])
		this.renderer = new StructureRenderer(gl, this.structure, this.resources)

		this.canvas2 = document.createElement('canvas')
		this.canvas2.className = 'structure-3d click-detection'
		this.gl2 = this.canvas2.getContext('webgl')!
		this.renderer2 = new StructureRenderer(this.gl2, this.structure, this.resources)

		this.warning = document.createElement('div')
		this.warning.className = 'nbt-warning'
		const warningMsg = document.createElement('span')
		warningMsg.textContent = 'Trying to render a very large structure'
		this.warning.append(warningMsg)
		const warningButton = document.createElement('div')
		warningButton.className = 'btn active'
		warningButton.textContent = 'Continue'
		warningButton.addEventListener('click', () => {
			this.warning.classList.remove('active')
			this.root.innerHTML = '<div class="spinner"></div>'
			setTimeout(() => {
				this.buildStructure()
				this.reveal()
				this.render()
			})
		})
		this.warning.append(warningButton)

		this.cPos = vec3.create()
		this.cRot = vec2.fromValues(0.4, 0.6)
		this.cDist = 10

		this.gridActive = true
		this.invisibleBlocksActive = false
		this.selectedBlock = null

		this.canvas.addEventListener('mousedown', evt => {
			this.dragTime = Date.now()
			this.dragPos = [evt.clientX, evt.clientY]
			this.dragButton = evt.button
		})
		this.canvas.addEventListener('mousemove', evt => {
			if (this.dragPos) {
				const dx = (evt.clientX - this.dragPos[0]) / 100
				const dy = (evt.clientY - this.dragPos[1]) / 100
				if (this.dragButton === 0) {
					vec2.add(this.cRot, this.cRot, [dx, dy])
					this.cRot[0] = this.cRot[0] % (Math.PI * 2)
					this.cRot[1] = clamp(this.cRot[1], -Math.PI / 2, Math.PI / 2)
				} else if (this.dragButton === 2 || this.dragButton === 1) {
					vec3.rotateY(this.cPos, this.cPos, [0, 0, 0], this.cRot[0])
					vec3.rotateX(this.cPos, this.cPos, [0, 0, 0], this.cRot[1])
					const d = vec3.fromValues(dx, -dy, 0)
					vec3.scale(d, d, 0.25 * this.cDist)
					vec3.add(this.cPos, this.cPos, d)
					vec3.rotateX(this.cPos, this.cPos, [0, 0, 0], -this.cRot[1])
					vec3.rotateY(this.cPos, this.cPos, [0, 0, 0], -this.cRot[0])
					clampVec3(this.cPos, negVec3(this.structure.getSize()), [0, 0, 0])
				} else {
					return
				}
				this.dragPos = [evt.clientX, evt.clientY]
				this.render()
			}
		})
		this.canvas.addEventListener('wheel', evt => {
			this.cDist += evt.deltaY / 100
			this.cDist = Math.max(1, Math.min(100, this.cDist))
			this.render()
		})

		window.addEventListener('blur', () => this.movement.fill(0))
		window.addEventListener('resize', () => {
			if (this.resize()) this.render()
		})

		this.render()
	}

	render() {
		if (this.renderRequested) {
			return
		}
		const requestTime = performance.now()
		this.renderRequested = true
		requestAnimationFrame((time) => {
			const delta = Math.max(0, time - requestTime)
			this.renderRequested = false
			this.resize()

			if (this.movement.some(m => m)) {
				vec3.rotateY(this.cPos, this.cPos, [0, 0, 0], this.cRot[0])
				const [w, a, s, d, space, shift] = this.movement
				const move = vec3.fromValues(a - d, shift - space, w - s)
				vec3.scaleAndAdd(this.cPos, this.cPos, move, delta * 0.02)
				vec3.rotateY(this.cPos, this.cPos, [0, 0, 0], -this.cRot[0])
				this.render()
			}

			const viewMatrix = this.getViewMatrix()

			if (this.gridActive) {
				this.renderer.drawGrid(viewMatrix)
			}

			if (this.invisibleBlocksActive) {
				this.renderer.drawInvisibleBlocks(viewMatrix)
			}

			this.renderer.drawStructure(viewMatrix)

			if (this.selectedBlock) {
				this.renderer.drawOutline(viewMatrix, this.selectedBlock)
			}
		})
	}

	resize() {
		const displayWidth2 = this.canvas2.clientWidth
		const displayHeight2 = this.canvas2.clientHeight
		if (this.canvas2.width !== displayWidth2 || this.canvas2.height !== displayHeight2) {
			this.canvas2.width = displayWidth2
			this.canvas2.height = displayHeight2
			this.renderer2.setViewport(0, 0, this.canvas2.width, this.canvas2.height)
		}

		const displayWidth = this.canvas.clientWidth
		const displayHeight = this.canvas.clientHeight
		if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
			this.canvas.width = displayWidth
			this.canvas.height = displayHeight
			this.renderer.setViewport(0, 0, this.canvas.width, this.canvas.height)
			return true
		}
		return false
	}

	reveal() {
		this.root.append(this.warning)
		this.root.append(this.canvas)
		this.root.append(this.canvas2)
		this.showSidePanel()
		document.addEventListener('keydown', this.onKeyDown)
		document.addEventListener('keyup', this.onKeyUp)
		window.addEventListener('mouseup', this.onMouseUp)
	}

	hide() {
		document.removeEventListener('keydown', this.onKeyDown)
		document.removeEventListener('keyup', this.onKeyUp)
		window.removeEventListener('mouseup', this.onMouseUp)
		this.movement.fill(0)
		this.dragPos = null
	}

	onInit(file: NbtFile) {
		this.updateStructure(file)
		vec3.copy(this.cPos, this.structure.getSize())
		vec3.scale(this.cPos, this.cPos, -0.5)
		this.cDist = Math.max(vec3.dist([0, 0, 0], this.cPos) * 1.5, 5)
		this.render()
	}

	onUpdate(file: NbtFile, edit: NbtEdit) {
		this.updateStructure(file)
		this.showSidePanel()
		this.render()
	}

	private dragTime = 0
	private dragPos: [number, number] | null = null
	private dragButton = 0

	private readonly onMouseUp = (evt: MouseEvent) => {
		if (!this.dragPos) return
		this.dragPos = null
		if (Date.now() - this.dragTime < 200 && this.dragButton === 0 && evt.target === this.canvas) {
			this.selectBlock(evt.clientX, evt.clientY)
		}
	}

	private readonly onKeyDown = (evt: KeyboardEvent) => {
		if ((evt.target as HTMLElement | null)?.closest('input, textarea, select')) return
		const index = this.movementKeys.indexOf(evt.code)
		if (index !== -1) {
			this.movement[index] = 1
			this.render()
		}
	}

	private readonly onKeyUp = (evt: KeyboardEvent) => {
		const index = this.movementKeys.indexOf(evt.code)
		if (index !== -1) {
			this.movement[index] = 0
		}
	}

	protected updateStructure(file: NbtFile) {
		this.file = file
		this.structure = this.loadStructure()
		const isLarge = this.isLarge()
		const toggle = document.querySelector('.invisible-blocks-toggle')
		toggle?.classList.toggle('unavailable', isLarge)
		toggle?.setAttribute('title', isLarge ? locale('invisibleBlocksUnavailable') : '')

		if (isLarge) {
			this.warning.classList.add('active')
			return
		}

		this.buildStructure()
	}

	protected isLarge() {
		const [x, y, z] = this.structure.getSize()
		return x * y * z > 48 * 48 * 48
	}

	protected loadStructure() {
		if (isSponge(this.file.root)) {
			return spongeToStructure(this.file.root)
		}
		if (this.file.root.hasCompound('Regions')) {
			return litematicToStructure(this.file.root)
		}
		if (this.file.root.get('Blocks')?.isByteArray() && this.file.root.get('Data')?.isByteArray()) {
			return schematicToStructure(this.file.root)
		}
		if (this.file.root.hasCompound('structure') && this.file.root.hasList('size', NbtType.Int, 3)) {
			return mcstructureToStructure(this.file.root)
		}
		const root = this.file.root
		if (!root.hasList('palette') && root.hasList('palettes', NbtType.List)) {
			// Structures with multiple palettes (e.g. shipwrecks), use the first one
			const palette = root.getList('palettes', NbtType.List).getList(0, NbtType.Compound).map(tag => BlockState.fromNbt(tag))
			const blocks = root.getList('blocks', NbtType.Compound).map(tag => {
				const nbt = tag.getCompound('nbt')
				return { pos: BlockPos.fromNbt(tag.getList('pos')), state: tag.getNumber('state'), nbt: nbt.size > 0 ? nbt : undefined }
			})
			return new Structure(BlockPos.fromNbt(root.getList('size')), palette, blocks)
		}
		return Structure.fromNbt(root)
	}

	private buildStructure() {
		const isLarge = this.isLarge()
		this.renderer.useInvisibleBlocks = !isLarge
		this.renderer2.useInvisibleBlocks = !isLarge
		this.renderer.setStructure(this.structure)
		this.renderer2.setStructure(this.structure)
	}

	menu() {
		const gridToggle = document.createElement('div')
		gridToggle.classList.add('btn')
		gridToggle.textContent = locale('grid')
		gridToggle.classList.toggle('active', this.gridActive)
		gridToggle.addEventListener('click', () => {
			this.gridActive = !this.gridActive
			gridToggle.classList.toggle('active', this.gridActive)
			this.render()
		})

		const invisibleBlocksToggle = document.createElement('div')
		invisibleBlocksToggle.classList.add('btn', 'invisible-blocks-toggle')
		invisibleBlocksToggle.textContent = locale('invisibleBlocks')
		invisibleBlocksToggle.classList.toggle('active', this.invisibleBlocksActive)
		invisibleBlocksToggle.addEventListener('click', () => {
			if (!this.renderer.useInvisibleBlocks) return
			this.invisibleBlocksActive = !this.invisibleBlocksActive
			invisibleBlocksToggle.classList.toggle('active', this.invisibleBlocksActive)
			this.render()
		})

		return [gridToggle, invisibleBlocksToggle]
	}

	private getViewMatrix() {
		const viewMatrix = mat4.create()
		mat4.translate(viewMatrix, viewMatrix, [0, 0, -this.cDist])
		mat4.rotateX(viewMatrix, viewMatrix, this.cRot[1])
		mat4.rotateY(viewMatrix, viewMatrix, this.cRot[0])
		mat4.translate(viewMatrix, viewMatrix, this.cPos)
		return viewMatrix
	}

	private selectBlock(x: number, y: number) {
		const viewMatrix = this.getViewMatrix()
		this.renderer2.drawColoredStructure(viewMatrix)
		const color = new Uint8Array(4)
		this.gl2.readPixels(x, this.canvas2.height - y, 1, 1, this.gl2.RGBA, this.gl2.UNSIGNED_BYTE, color)
		const oldSelectedBlock = this.selectedBlock ? [...this.selectedBlock] : null
		if (color[3] === 255) {
			this.selectedBlock = [color[0], color[1], color[2]]
		} else {
			this.selectedBlock = null
		}
		if (JSON.stringify(oldSelectedBlock) !== JSON.stringify(this.selectedBlock)) {
			this.showSidePanel()
			this.render()
		}
	}

	protected showSidePanel() {
		this.root.querySelector('.side-panel')?.remove()
		const block = this.selectedBlock ? this.structure.getBlock(this.selectedBlock) : null

		const readOnly = this.readOnly || !this.file.root.hasList('size', NbtType.Int, 3) || this.file.root.hasCompound('structure')

		const sidePanel = document.createElement('div')
		sidePanel.classList.add('side-panel')
		this.root.append(sidePanel)
		if (block) {
			const properties = block.state.getProperties()
			const name = document.createElement('div')
			name.className = 'block-name'
			name.textContent = block.state.getName().toString()
			const pos = document.createElement('div')
			pos.className = 'block-pos'
			pos.textContent = block.pos.join(' ')
			sidePanel.append(name, pos)
			const entries = Object.entries(properties)
			if (entries.length > 0) {
				const props = document.createElement('div')
				props.className = 'block-props'
				for (const [k, v] of entries) {
					const key = document.createElement('span')
					key.className = 'prop-key'
					key.textContent = k
					const value = document.createElement('span')
					value.className = 'prop-value'
					value.textContent = v
					props.append(key, value)
				}
				sidePanel.append(props)
			}
			if (block.nbt) {
				const nbtTree = document.createElement('div')
				sidePanel.append(nbtTree)
				const blockIndex = this.file.root.getList('blocks', NbtType.Compound).getItems()
					.findIndex(t => BlockPos.equals(BlockPos.fromNbt(t.getList('pos')), block.pos))
				const tree = new TreeEditor(nbtTree, this.vscode, edit => {
					this.editHandler(mapEdit(edit, e => {
						return { ...e, path: ['blocks', blockIndex, 'nbt', ...e.path] }
					}))
				}, readOnly)
				tree.onInit(new NbtFile('', block.nbt, 'none', this.file.littleEndian, undefined))
				tree.reveal()
			}
		} else {
			sidePanel.innerHTML = `
				<div class="structure-size">
					<label>Size</label>
					<input type="number" ${readOnly ? 'readonly' : ''}>
					<input type="number" ${readOnly ? 'readonly' : ''}>
					<input type="number" ${readOnly ? 'readonly' : ''}>
				</div>
			`
			sidePanel.querySelectorAll('.structure-size input').forEach((el, i) => {
				const original = this.structure.getSize()[i];
				(el as HTMLInputElement).value = original.toString()
				if (readOnly) return

				el.addEventListener('change', () => {
					const value = parseInt((el as HTMLInputElement).value)
					if (!Number.isInteger(value) || value <= 0) {
						(el as HTMLInputElement).value = original.toString()
						return
					}
					this.editHandler({
						type: 'set',
						path: ['size', i],
						old: new NbtInt(original).toJsonWithId(),
						new: new NbtInt(value).toJsonWithId(),
					})
				})
			})
		}
	}
}
