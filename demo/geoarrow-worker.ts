import { tableFromIPC, tableToIPC } from 'apache-arrow';
import { toGeoArrowTable } from '../dist/geoarrow.js';
import { pathIntersectsBoxXY } from '../dist/geometry.js';
import { getLineStringById, querySpatialIndex } from '../dist/spatial.js';
import { SharedList } from '../dist/shared.js';

self.onmessage = ({ data }) => {
  if ('lookup' in data) {
    const original = getLineStringById(data.lookup, data.id)!;
    const visible = querySpatialIndex(data.index, data.box).filter(id =>
      pathIntersectsBoxXY(getLineStringById(data.lookup, id)!, data.box));
    const edited = new SharedList('number').pushMany(original).set(2, 9);
    self.postMessage({ original, visible, edited: edited.toFloat64Array() });
    return;
  }
  const table = toGeoArrowTable(data);
  const column = table.getChild('geometry')!.data[0]!;
  const encoded = tableToIPC(table, 'stream');
  const decoded = tableFromIPC(encoded);
  self.postMessage({
    extension: decoded.schema.fields[0].metadata.get('ARROW:extension:name'),
    rows: Array.from(decoded.getChild('geometry')!, line => line && Array.from(line, xy => [...xy])),
    coordinates: column.children[0].children[0].values,
  });
};
