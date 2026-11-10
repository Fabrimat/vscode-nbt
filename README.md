# NBT Plus for VS Code
View and edit Minecraft NBT files in VS Code, with a 3D block view for structures.

![](https://user-images.githubusercontent.com/17352009/104337363-b4aeb000-54f5-11eb-93a2-47ce2e3e4fea.png)

This is a maintained continuation (fork) of [NBT Viewer](https://github.com/misode/vscode-nbt) by [Misode](https://github.com/misode).

## Features

* NBT tree editor: add, edit, rename, move and remove tags
* SNBT view of the whole file or of a selected tag
* 3D structure viewer, including Bedrock `.mcstructure`
* Region file (`.mca`) support
* Map rendering
* Java (big-endian) and Bedrock (little-endian) NBT

## Supported files

| Extension | Notes |
| --- | --- |
| `.nbt` | Structure files, 3D view |
| `.mcstructure` | Bedrock structures, 3D view |
| `.litematic` | Litematica schematics, 3D view |
| `.schem`, `.schematic` | WorldEdit / MCEdit schematics, 3D view |
| `.mca` | Region files |
| `.dat`, `.dat_old` | Generic NBT (level, player, map data...) |

## 3D viewer controls

| Input | Action |
| --- | --- |
| Left mouse drag | Rotate the camera |
| Right or middle mouse drag | Pan the camera |
| Mouse wheel | Zoom in and out |
| `W` `A` `S` `D` | Move the camera forward, left, backward, right |
| `Space` / `Left Shift` | Move the camera up / down |
| Left click on a block | Select it and show its details in the side panel |

The side panel also has toggles for the grid and for invisible blocks. Very large structures show a warning first and must be confirmed with **Continue**.

## Install

* [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Fabrimat.vscode-nbt-plus)
* [Open VSX](https://open-vsx.org/extension/Fabrimat/vscode-nbt-plus)

## Contributing

Issues and pull requests are welcome at [Fabrimat/vscode-nbt](https://github.com/Fabrimat/vscode-nbt/issues).

## Credits

* [Misode](https://github.com/misode) for the original [NBT Viewer](https://github.com/misode/vscode-nbt)
* [AmberW](https://github.com/AmberWat) for the NBT icons
* [SPGoding](https://github.com/SPGoding) for the downloading and caching logic from [Spyglass](https://github.com/SpyglassMC/Spyglass)

## Disclaimer
While this extension has been tested, it can technically corrupt your files. Always be careful and backup important files.
