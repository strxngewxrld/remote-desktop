# Extension-Icons

Das gemeinsame Motiv ist ein Monitor mit zwei Übertragungspfeilen.

| Datei | Verwendung |
| --- | --- |
| `packages/vscode-rdp/media/icon.png` | Marketplace und Extension-Details, 512 × 512 Pixel |
| `packages/vscode-rdp/media/icon.svg` | Skalierbare Vorlage für das Marketplace-Icon |
| `packages/vscode-rdp/media/rdp-icon.svg` | Monochromes Symbol für die Activity Bar |
| `packages/vscode-rdp/media/rdp-icon-light.svg` | Sitzungs-Tab bei hellem Theme |
| `packages/vscode-rdp/media/rdp-icon-dark.svg` | Sitzungs-Tab bei dunklem Theme |
| `packages/vscode-rdp/media/tab-icons/rdp-*.svg` | Kennfarben mit unterschiedlichen Formen zur Unterscheidung von Umgebungen |

Die Assets werden statisch mitgeliefert. Während einer Sitzung sind keine Downloads
oder Schreibzugriffe zum Erzeugen der Icons nötig. VS Code wählt die passende
helle bzw. dunkle Tabvariante. Editor-Icons werden sichtbar, wenn
`workbench.editor.showIcons` aktiviert ist.

Die Haupticons lassen sich unter Windows ohne zusätzliche npm-Abhängigkeiten
neu erzeugen:

```powershell
powershell -File tools/Generate-Icons.ps1
```

Der Export verwendet System.Drawing. Der CI-Paket-Build verwendet die eingecheckten
Assets und benötigt den Windows-Exporter nicht. Der Paketcheck prüft die
ausgelieferten Dateien sowie PNG-Format und Mindestgröße des Marketplace-Icons.
Die Motive sind eigene Zeichnungen des Projekts und stehen unter dessen MIT-Lizenz.
