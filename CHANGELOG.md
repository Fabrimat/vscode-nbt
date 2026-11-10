# Changelog

## 1.0.0

* First release as VSCode NBT Plus, a maintained continuation of misode's NBT Viewer
* Merged all upstream changes up to 0.9.7
* Added 3D structure view for Bedrock `.mcstructure` files
* Litematic: fixed Minecraft version detection and the offset of regions with negative size (upstream PR #101)
* Float and double tags now preserve `NaN` and `Infinity` (upstream #97)
* Double-clicking inside the value field no longer discards edits (upstream #96)
* Assets are only loaded for files that need to be rendered (upstream #71)
* Added a list of 3D viewer controls to the README (upstream #69)
* Renamed the editor id so it can be installed next to the original extension
<!-- TODO verify: prune any of the following that did not land -->
* Fixed: upstream issue #93
* Fixed: upstream issue #86
* Fixed: upstream issue #53
* Fixed: upstream issue #64
* Fixed: upstream issue #72
* Fixed: upstream issue #87
* Fixed: upstream issue #89

For older versions (0.9.7 and earlier) see the [upstream releases](https://github.com/misode/vscode-nbt/releases).
