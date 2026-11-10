const LOCALES = {
	copy: 'Copy',
	'snbt.tooLarge': 'This SNBT is too large to show here (%0 lines).',
	'snbt.openInEditor': 'Open in Text Editor',
	name: 'Name',
	value: 'Value',
	confirm: 'Confirm',
	addTag: 'Add Tag',
	editTag: 'Edit',
	removeTag: 'Remove',
	renameTag: 'Rename',
	grid: 'Show Grid',
	invisibleBlocks: 'Show Invisible Blocks',
	invisibleBlocksUnavailable: 'Invisible blocks is unavailable for large structures',
	'panel.structure': '3D',
	'panel.chunk': '3D',
	'panel.map': 'Map',
	'panel.region': 'Region',
	'panel.default': 'Default',
	'panel.snbt': 'SNBT',
	'panel.info': 'File Info',
}

export function locale(key: string) {
	return LOCALES[key] ?? key
}
