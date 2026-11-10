import type { NbtFile } from 'deepslate'
import { NbtTag } from 'deepslate'
import type { EditHandler, EditorPanel, VSCode } from './Editor'
import { locale } from './Locale'

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
		this.setText(textarea)
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
		content.append(textarea, error)
		this.root.append(content)
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
		textarea.value = this.snbt
	}

	onUpdate(file: NbtFile) {
		this.onInit(file)
	}

	menu() {
		const copyButton = document.createElement('div')
		copyButton.classList.add('btn')
		copyButton.textContent = locale('copy')
		copyButton.addEventListener('click', () => {
			const textarea = this.root.querySelector('.snbt-editor') as HTMLTextAreaElement
			textarea.select()
			document.execCommand('copy')
		})

		return [copyButton]
	}
}
