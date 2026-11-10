# Changelog

## 1.0.0

First release as NBT Plus for VS Code, a maintained continuation of misode's NBT Viewer. Includes all upstream changes up to 0.9.7.

### Added
* 3D structure view for Bedrock `.mcstructure` files, including the water layer
* Sponge schematic v3 and Java structures with multiple palettes
* List of 3D viewer controls in the README (upstream #69)
* Published on Open VSX (upstream #19)

### Fixed
* Region files from Minecraft 26.3+ with string block palettes now render (upstream #93)
* Chunk sections with a single palette entry and no data now render (upstream #86)
* Delete and F2 no longer act on the selected tag while typing, and the 3D camera no longer moves while typing (upstream #53, #64)
* Replace and Replace All buttons now work (upstream #72)
* Files with strings longer than 32767 bytes no longer fail with "Maximum call stack size exceeded" (upstream #87)
* Parse errors now report the real cause instead of "Top tag should be a compound" (upstream #89, #56)
* Saving no longer silently skips the write after a revert, after undo followed by a new edit, or after restoring a backup
* Reverting now refreshes the open editors
* Invalid or out-of-range numbers are rejected instead of being silently truncated
* Renaming or replacing no longer deletes list elements or overwrites existing keys
* Multi-line strings keep their line breaks when edited
* Legacy `.schematic` block ids above 127 and Sponge palettes with more than 127 entries are decoded correctly
* Litematic version detection and the offset of regions with negative size (upstream PR #101)
* Float and double tags preserve `NaN` and `Infinity` (upstream PR #97)
* Double-clicking inside the value field no longer discards edits (upstream PR #96)
* Cmd+F and Cmd+H work on macOS

### Changed
* Opening files no longer waits on the network when Minecraft assets are cached, and failed downloads time out and show an error instead of a blank editor (upstream #55, #79)
* Assets are only loaded for files that are rendered in 3D (upstream PR #71)
* Block models are prepared on first use, which speeds up opening structures
* The editor id was renamed so the extension can be installed next to the original one
* Requires VS Code 1.66 or newer

For older versions (0.9.7 and earlier) see the [upstream releases](https://github.com/misode/vscode-nbt/releases).
