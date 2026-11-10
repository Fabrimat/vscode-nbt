import type { NbtFile } from 'deepslate'
import { NbtTag } from 'deepslate'
import type { EditHandler, EditorPanel, VSCode } from './Editor'
import { locale } from './Locale'

// native textareas take about a second per 50k lines to lay out
const MAX_INLINE_LINES = 20000

export class SnbtEditor implements EditorPanel {
	private file: NbtFile
	private snbt: string

	constructor(private readonly root: Element, private readonly vscode: VSCode, private readonly editHandler: EditHandler, private readonly readOnly: boolean) {
		this.snbt = ''
	}

	reveal() {
		const content = document.createElement('div')
		content.classList.add('nbt-content')
		const textarea = document.createElement('textarea')
		textarea.classList.add('snbt-editor')
		textarea.readOnly = this.readOnly
		const large = document.createElement('div')
		large.classList.add('snbt-large')
		const largeMessage = document.createElement('p')
		const openButton = document.createElement('div')
		openButton.classList.add('btn')
		openButton.textContent = locale('snbt.openInEditor')
		openButton.addEventListener('click', () => {
			this.vscode.postMessage({ type: 'openSnbt', body: this.snbt })
		})
		large.append(largeMessage, openButton)
		const error = document.createElement('div')
		error.classList.add('error', 'snbt-error')
		textarea.addEventListener('change', () => {
			if (this.readOnly) return
			try {
				const newRoot = NbtTag.fromString(textarea.value)
				error.textContent = ''
				this.editHandler({ type: 'set', path: [], old: this.file.root.toJsonWithId(), new: newRoot.toJsonWithId() })
			} catch (e) {
				error.textContent = e instanceof Error ? e.message : String(e)
			}
		})
		content.append(textarea, large, error)
		this.root.append(content)
		this.setText(textarea)
	}

	onInit(file: NbtFile) {
		this.file = file
		this.snbt = file.root.toPrettyString('  ')
		const textarea = this.root.querySelector<HTMLTextAreaElement>('.snbt-editor')
		if (textarea) {
			this.setText(textarea)
			const error = this.root.querySelector('.snbt-error')
			if (error) error.textContent = ''
		}
	}

	// textContent only sets the default value, which is ignored once the user has edited the textarea
	private setText(textarea: HTMLTextAreaElement) {
		const lines = (this.snbt.match(/\n/g)?.length ?? 0) + 1
		const tooLarge = lines > MAX_INLINE_LINES
		textarea.value = tooLarge ? '' : this.snbt
		textarea.style.display = tooLarge ? 'none' : ''
		const large = this.root.querySelector<HTMLElement>('.snbt-large')
		if (large) {
			large.style.display = tooLarge ? '' : 'none'
			large.querySelector('p')!.textContent = locale('snbt.tooLarge').replace('%0', `${lines}`)
		}
	}

	onUpdate(file: NbtFile) {
		this.onInit(file)
	}

	menu() {
		const copyButton = document.createElement('div')
		copyButton.classList.add('btn')
		copyButton.textContent = locale('copy')
		copyButton.addEventListener('click', () => {
			navigator.clipboard.writeText(this.snbt)
		})

		return [copyButton]
	}
}
