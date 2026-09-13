import { einstellungen, zuruecksetzen, DataTransfer } from './vscodeStub.js';
import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'node:test';
import { ConnectionTreeProvider, getBaum } from '../src/connections.js';

beforeEach(() => zuruecksetzen());

test('Drag-and-drop verschiebt in Ordner, aus Ordner und verhindert Zyklen', async () => {
  einstellungen.set('rdp.connections', [{ name: 'Server', host: 'host' }, { type: 'folder', name: 'Ordner', children: [] }]);
  const tree = new ConnectionTreeProvider();
  let nodes = tree.getChildren();
  const data = new DataTransfer();
  tree.handleDrag([nodes[0]!], data);
  await tree.handleDrop(nodes[1], data);
  assert.equal(getBaum().length, 1);
  nodes = tree.getChildren();
  tree.handleDrag([nodes[0]!], data);
  await tree.handleDrop(nodes[0], data);
  assert.equal(getBaum().length, 1);
  tree.handleDrag(tree.getChildren(nodes[0]), data);
  await tree.handleDrop(undefined, data);
  assert.equal(getBaum().length, 2);
});

test('Veraltete Drag-Pfade verändern den inzwischen bearbeiteten Baum nicht', async () => {
  einstellungen.set('rdp.connections', [{ name: 'Server', host: 'host' }]);
  const tree = new ConnectionTreeProvider();
  const data = new DataTransfer();
  tree.handleDrag(tree.getChildren(), data);
  einstellungen.set('rdp.connections', [{ name: 'Anderer', host: 'other' }]);
  await tree.handleDrop(undefined, data);
  assert.equal(getBaum()[0]!.name, 'Anderer');
});
